#!/usr/bin/env node
/**
 * Opt-in real-host smoke test against a locally installed OpenCode v2 CLI
 * (verified against v2.0.22; POSIX-only, fails fast on win32). Opt-in: NOT
 * part of `pnpm verify` or CI — runners don't install OpenCode.
 *
 * What it does, concisely:
 *
 * 1. Builds and packs the product with `pnpm run build` + `pnpm pack`, then
 *    extracts the tarball into the temp tree and links the repo's existing
 *    `node_modules` for the runtime peer dependency. No npm publishing,
 *    registry downloads or external installs; the package is NOT published.
 * 2. Starts a loopback-only fake OpenAI-compatible endpoint and a local
 *    models.dev-format catalog (`OPENCODE_MODELS_PATH` +
 *    `OPENCODE_DISABLE_MODELS_FETCH=1`), then loads the PACKED PRODUCT
 *    PACKAGE ITSELF through the official `plugins` config entry (the host
 *    delivers the entry `options` to `ctx.options` natively).
 * 3. A separate downstream consumer plugin (temp root package, `main:
 *    index.js`, loaded after the product) reads `ctx.model.list()` and
 *    asserts the host catalog state: `localfake/latest` selectable,
 *    `enabled=true`, execution `modelID=fake-large`. It emits a public-field
 *    sentinel via `console.warn` on success and throws otherwise, so a
 *    silently skipped product cannot pass on wire-model evidence alone.
 * 4. Runs `opencode run --standalone --model localfake/latest --format json
 *    --print-logs` under a bounded timeout that kills the whole child process
 *    group, and asserts: exit 0; a genuine assistant `text` stdout event with
 *    exactly "pong" (never a substring of an echoed prompt or log line);
 *    every chat request to the loopback endpoint carries
 *    `body.model === "fake-large"` and the dummy test key; the consumer
 *    sentinel and the `[opencode-floating-models] [debug]` alias→winner line
 *    appear in stderr; no "failed to load plugin".
 *
 * Isolation: `HOME` and all XDG dirs are unique temp directories created
 * before the version probe; the CLI subprocesses get a minimal allow-listed
 * environment (no `process.env` spread) — only PATH/HOME/TMPDIR, isolated
 * XDG/`OPENCODE_*` vars and the fake provider's dummy test key. Network stays
 * on 127.0.0.1. Failures throw, so the final cleanup always closes the
 * server, kills subprocess groups and removes exactly this temp tree.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "opencode-floating-models";
const PROVIDER = "localfake";
const ALIAS_KEY = "localfake/latest";
const TARGET = "fake-large";
const DUMMY_KEY = "smoke-dummy-key-not-a-credential";
const CLI_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 120_000;

function childEnv(dir) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: path.join(dir, "home"),
    TMPDIR: os.tmpdir(),
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    XDG_DATA_HOME: path.join(dir, "xdg-data"),
    XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
    XDG_RUNTIME_DIR: path.join(dir, "xdg-runtime"),
    OPENCODE_MODELS_PATH: path.join(dir, "models.json"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    LOCALFAKE_API_KEY: DUMMY_KEY,
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

/**
 * Spawn a subprocess in its own process group with a bounded timeout and
 * group kill (covers detached `opencode serve --stdio` descendants too).
 * Spawn `error` and `close` both resolve the promise exactly once.
 */
function runSpawn(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // process group already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        killGroup();
        resolve({ code: null, timedOut, stdout, stderr, spawnError: error });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        killGroup();
        resolve({ code, timedOut, stdout, stderr, spawnError: null });
      }
    });
  });
}

function modelEntry(id, name, releaseDate) {
  return {
    id,
    name,
    tool_call: true,
    reasoning: false,
    attachment: false,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    release_date: releaseDate,
    limit: { context: 8192, output: 4096 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

function chatResponse(requestBody, content) {
  return {
    id: "chatcmpl-smoke",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestBody.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function serveStream(res, requestBody, content) {
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created,
      model: requestBody.model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`;
  res.write(chunk({ role: "assistant" }));
  res.write(chunk({ content }));
  res.write(chunk({}, "stop"));
  res.end("data: [DONE]\n\n");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Fake OpenAI-compatible endpoint: only the dummy key authorizes chat calls. */
function startFakeServer(requests) {
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization ?? "";
    const chat = req.method === "POST" && url.pathname.endsWith("/chat/completions");
    requests.push({ method: req.method, pathname: url.pathname, body, auth });
    if (chat && auth !== `Bearer ${DUMMY_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    if (chat) {
      if (body.stream === true) return serveStream(res, body, "pong");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatResponse(body, "pong")));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  // POSIX-only: fallar ANTES de crear recursos o procesos hijos.
  if (process.platform === "win32") {
    throw new Error("POSIX-only smoke; run it on macOS/Linux.");
  }

  // Temp único primero: HOME/XDG aislados existen ya para el probe de versión
  // y para todo lo demás. Todo lo posterior a la adquisición del directorio va
  // dentro de try/finally: cualquier fallo elimina exactamente este árbol.
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-floating-models-smoke-"));

  let server = null;
  const requests = [];
  try {
    for (const subdir of [
      "home",
      "xdg-config",
      "xdg-data",
      "xdg-cache",
      "xdg-runtime",
      "packed",
      "extracted",
    ]) {
      await mkdir(path.join(dir, subdir), { recursive: true });
    }
    const env = childEnv(dir);

    const version = await runSpawn("opencode", ["--version"], { cwd: dir, env, timeoutMs: 30_000 });
    const probe = (version.stdout + version.stderr).trim();
    const match = /v?(\d+)\./.exec(probe);
    const major =
      version.code === 0 && !version.timedOut ? (match ? Number(match[1]) : null) : null;
    if (major !== 2) {
      throw new Error(
        `OpenCode v2 CLI is required on PATH (probe: code=${version.code}, timedOut=${version.timedOut}, spawnError=${version.spawnError}, output=${JSON.stringify(probe.slice(0, 200))}). This smoke is opt-in and is NOT part of \`pnpm verify\`/CI.`,
      );
    }
    console.log("smoke:opencode: OpenCode CLI v2 detected.");

    // Build primero: dist rancio no puede hacer pasar el smoke falsamente.
    const build = await runSpawn("pnpm", ["run", "build"], {
      cwd: REPO_ROOT,
      env,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (build.timedOut || build.spawnError || build.code !== 0) {
      throw new Error(
        `pnpm run build failed (code=${build.code}, timedOut=${build.timedOut}, spawnError=${build.spawnError})\n${build.stderr.slice(-2000)}`,
      );
    }

    const pack = await runSpawn("pnpm", ["pack", "--pack-destination", path.join(dir, "packed")], {
      cwd: REPO_ROOT,
      env,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (pack.timedOut || pack.spawnError || pack.code !== 0) {
      throw new Error(
        `pnpm pack failed (code=${pack.code}, timedOut=${pack.timedOut}, spawnError=${pack.spawnError})\n${pack.stderr.slice(-2000)}`,
      );
    }
    const tarballs = (await readdir(path.join(dir, "packed"))).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one packed tarball, found: ${tarballs.join(", ")}`);
    }
    const tarball = path.join(dir, "packed", tarballs[0]);
    const extract = await runSpawn("tar", ["-xzf", tarball, "-C", path.join(dir, "extracted")], {
      cwd: dir,
      env,
      timeoutMs: 30_000,
    });
    if (extract.timedOut || extract.spawnError || extract.code !== 0) {
      throw new Error(
        `tar extraction failed (code=${extract.code}, timedOut=${extract.timedOut}, spawnError=${extract.spawnError})\n${extract.stderr.slice(-2000)}`,
      );
    }
    const pkgDir = path.join(dir, "extracted", "package");
    try {
      await symlink(path.join(REPO_ROOT, "node_modules"), path.join(pkgDir, "node_modules"), "dir");
    } catch {
      throw new Error("failed to link repo node_modules into the extracted package");
    }

    // Comprobación de import del tarball local: el entrypoint raíz del paquete
    // distribuido debe exportar el plugin y los re-exports públicos.
    const product = await import(pathToFileURL(path.join(pkgDir, "index.js")).href);
    if (typeof product.default?.setup !== "function") {
      throw new Error(
        "packed product root entrypoint did not export a plugin definition with setup()",
      );
    }
    if (typeof product.normalizeOptions !== "function") {
      throw new Error(
        "packed product root entrypoint is missing the public normalizeOptions re-export",
      );
    }
    console.log(`smoke:opencode: packed product imports cleanly (${tarballs[0]})`);

    server = await startFakeServer(requests);
    const port = server.address().port;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    console.log(`smoke:opencode: local model server listening at http://127.0.0.1:${port}`);

    // Plugin consumidor: otro paquete temporal con main:index.js, cargado
    // DESPUÉS del producto. Solo afirma el estado del catálogo del host y
    // emite un sentinel con campos públicos; jamás imprime options/headers
    // ni credenciales.
    const consumerDir = path.join(dir, "consumer-pkg");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({
        name: "smoke-catalog-consumer",
        version: "0.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    await writeFile(
      path.join(consumerDir, "index.js"),
      `export default {\n` +
        `  id: "smoke-catalog-consumer",\n` +
        `  async setup(ctx) {\n` +
        `    const { data } = await ctx.model.list();\n` +
        `    if (!Array.isArray(data)) throw new Error("smoke-catalog-consumer: ctx.model.list() returned no model array");\n` +
        `    const alias = data.find((m) => m.providerID === "localfake" && m.id === "latest");\n` +
        `    if (!alias) {\n` +
        `      const seen = data.map((m) => m.providerID + "/" + m.id).join(", ");\n` +
        `      throw new Error("smoke-catalog-consumer: localfake/latest not selectable; providers seen: " + seen);\n` +
        `    }\n` +
        `    if (alias.enabled !== true) throw new Error("smoke-catalog-consumer: localfake/latest is not enabled");\n` +
        `    if (alias.modelID !== "fake-large") throw new Error("smoke-catalog-consumer: localfake/latest execution modelID is " + alias.modelID + ", expected fake-large");\n` +
        `    console.warn("smoke-catalog-consumer: catalog OK providerID=localfake id=latest enabled=true modelID=fake-large");\n` +
        `    return () => {};\n` +
        `  },\n` +
        `};\n`,
    );

    const project = path.join(dir, "proj");
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          autoupdate: false,
          model: ALIAS_KEY,
          plugins: [
            {
              package: pkgDir,
              options: {
                aliases: {
                  [ALIAS_KEY]: { match: `${PROVIDER}/fake-*`, select: { strategy: "latest" } },
                },
                strict: true,
                debug: true,
              },
            },
            { package: consumerDir, options: {} },
          ],
          providers: {
            [PROVIDER]: {
              name: "LocalFake",
              package: "@ai-sdk/openai-compatible",
              env: ["LOCALFAKE_API_KEY"],
              options: { apiKey: DUMMY_KEY, baseURL: endpoint },
            },
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      path.join(dir, "models.json"),
      JSON.stringify({
        [PROVIDER]: {
          id: PROVIDER,
          name: "LocalFake",
          npm: "@ai-sdk/openai-compatible",
          api: endpoint,
          env: ["LOCALFAKE_API_KEY"],
          models: {
            "fake-small": modelEntry("fake-small", "Fake Small", "2025-01-01"),
            "fake-large": modelEntry("fake-large", "Fake Large", "2025-06-01"),
          },
        },
      }),
    );

    const run = await runSpawn(
      "opencode",
      [
        "run",
        "--standalone",
        "--model",
        ALIAS_KEY,
        "--format",
        "json",
        "--print-logs",
        "Reply with exactly pong.",
      ],
      { cwd: project, env, timeoutMs: CLI_TIMEOUT_MS },
    );

    const problems = [];
    if (run.timedOut) {
      problems.push(`opencode run did not finish within ${CLI_TIMEOUT_MS / 1000}s (group killed)`);
    } else if (run.code !== 0) {
      problems.push(`opencode run exited with code ${run.code}`);
    }
    if (run.spawnError) problems.push(`spawning opencode failed: ${run.spawnError}`);

    // Evento de texto del asistente, exactamente "pong", desde stdout JSON.
    const events = run.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);
    const pongEvent = events.find(
      (event) => event.type === "text" && event.part?.type === "text" && event.part.text === "pong",
    );
    if (!pongEvent) {
      problems.push('stdout had no assistant text event with text exactly "pong"');
    }

    const chatRequests = requests.filter((r) => r.pathname.endsWith("/chat/completions"));
    if (chatRequests.length === 0) {
      problems.push("no chat completion request reached the local server");
    }
    for (const request of chatRequests) {
      if (request.body?.model !== TARGET) {
        problems.push(
          `chat request used upstream model "${request.body?.model}", expected "${TARGET}"`,
        );
      }
      if (request.auth !== `Bearer ${DUMMY_KEY}`) {
        problems.push("a chat request did not use the dummy test key");
      }
    }

    const SENTINEL =
      "smoke-catalog-consumer: catalog OK providerID=localfake id=latest enabled=true modelID=fake-large";
    if (!run.stderr.includes(SENTINEL)) {
      problems.push(`stderr did not contain the consumer catalog sentinel "${SENTINEL}"`);
    }
    const debugLine = `[${PLUGIN_ID}] [debug] alias "${ALIAS_KEY}" -> ${PROVIDER}/${TARGET}`;
    if (!run.stderr.includes(debugLine)) {
      problems.push(`stderr did not contain the plugin debug line "${debugLine}"`);
    }
    if (/failed to load plugin/.test(run.stderr)) {
      problems.push('host logged "failed to load plugin"');
    }

    if (problems.length > 0) {
      console.error("smoke:opencode: FAILED");
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("--- stdout (last 3000 chars) ---");
      console.error(run.stdout.slice(-3000) || "(empty)");
      console.error("--- stderr (last 3000 chars) ---");
      console.error(run.stderr.slice(-3000) || "(empty)");
      const interesting = run.stderr
        .split("\n")
        .filter((line) => /opencode-floating-models|smoke-catalog-consumer|debug/.test(line));
      console.error("--- plugin-relevant stderr lines ---");
      console.error(interesting.join("\n") || "(none)");
      // Lanzar en vez de exit: el finally cierra el servidor y borra el temp.
      throw new Error(`smoke:opencode: FAILED with ${problems.length} problem(s)`);
    }

    console.log("smoke:opencode: PASSED");
    console.log(
      `  alias ${ALIAS_KEY} materialized as ${PROVIDER}/${TARGET} (catalog + wire model)`,
    );
    console.log(`  chat requests observed: ${chatRequests.length}`);
    console.log("  assistant text event: pong (exact match)");
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`smoke:opencode: ${error?.stack ?? String(error)}`);
  process.exitCode = 1;
});
