#!/usr/bin/env node
/**
 * Opt-in real-host smoke test against a locally installed OpenCode v2 CLI
 * (POSIX-only, fails fast on win32). Runs in CI against pinned minimum and
 * current hosts; also available locally when OpenCode is on PATH.
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
 *    PACKAGE ITSELF through the official `plugins` config entry with
 *    FILE-ONLY configuration: the plugin entry carries no `options` and the
 *    configuration comes exclusively from a
 *    `.opencode/opencode-model-aliases.jsonc` file (JSONC comments and
 *    trailing commas) in the temp project, exercising the plugin's own file
 *    loader.
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
 *    sentinel and the `[opencode-model-aliases] [debug]` alias→winner line
 *    appear in stderr; no "failed to load plugin".
 * 5. Opt-in `--inspect` mode (`pnpm smoke:inspect`): same isolation and
 *    packed-product loading, but instead of a real session it verifies the
 *    actual `opencode api` CLI shape and POSTs the plugin RPC through the
 *    host's real HTTP surface —
 *    `opencode api --standalone post /api/rpc/opencode-model-aliases/inspect
 *    --data '{"input":{}}'` — asserting the report shows
 *    `localfake/latest → localfake/fake-large (active)` with strategy latest
 *    and ZERO provider requests observed by the loopback sink (inspection
 *    performs no model call and no session execution).
 *
 * Isolation: `HOME` and all XDG dirs are unique temp directories created
 * before the version probe; the CLI subprocesses get a minimal allow-listed
 * environment (no `process.env` spread) — only PATH/HOME/TMPDIR, isolated
 * XDG/`OPENCODE_*` vars and the fake provider's dummy test key. Network stays
 * on 127.0.0.1. Failures throw, so the final cleanup always closes the
 * server, kills subprocess groups and removes exactly this temp tree.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "opencode-model-aliases";
const PROVIDER = "localfake";
const ALIAS_KEY = "localfake/latest";
const TARGET = "fake-large";
const DUMMY_KEY = "smoke-dummy-key-not-a-credential";
const CLI_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 120_000;
// Opt-in `--inspect` mode: instead of generating text (real session), verifies
// the inspection report via the host's real RPC (opencode api) and requires
// zero provider requests.
const INSPECT = process.argv.includes("--inspect");

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
    limit: { context: 128000, output: 4096 },
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
  // POSIX-only: fail BEFORE creating resources or child processes.
  if (process.platform === "win32") {
    throw new Error("POSIX-only smoke; run it on macOS/Linux.");
  }

  // Unique temp dir first: isolated HOME/XDG exists already for the version
  // probe and for everything else. Everything after the directory acquisition
  // goes inside try/finally: any failure removes exactly this tree.
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-aliases-smoke-"));

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
        `OpenCode v2 CLI is required on PATH (probe: code=${version.code}, timedOut=${version.timedOut}, spawnError=${version.spawnError}, output=${JSON.stringify(probe.slice(0, 200))}). Install @opencode/cli and rerun this smoke.`,
      );
    }
    console.log(`smoke:opencode: OpenCode ${probe} detected.`);

    // Build first: stale dist must not make the smoke pass falsely.
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

    // Import check of the local tarball: the distributed package's root
    // entrypoint must export the plugin and the public re-exports.
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
    // The distributed package must expose the TUI: root wrapper + compiled
    // build with its types ("./tui" export in package.json + files).
    for (const part of ["tui.js", path.join("dist", "tui.js"), path.join("dist", "tui.d.ts")]) {
      if (!existsSync(path.join(pkgDir, part))) {
        throw new Error(`packed product is missing "${part}" (required by the ./tui export)`);
      }
    }
    console.log(`smoke:opencode: packed product imports cleanly (${tarballs[0]})`);

    server = await startFakeServer(requests);
    const port = server.address().port;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    console.log(`smoke:opencode: local model server listening at http://127.0.0.1:${port}`);

    // Consumer plugin: another temp package with main:index.js, loaded AFTER
    // the product. Only asserts the host catalog state and emits a sentinel
    // with public fields; never prints options/headers or credentials.
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
    // Plugin config ONLY in a separate JSONC file (comments + trailing
    // commas): the native plugin entry carries no options and the file must
    // be found by walking up from the project cwd.
    const pluginConfigDir = path.join(project, ".opencode");
    await mkdir(pluginConfigDir, { recursive: true });
    await writeFile(
      path.join(pluginConfigDir, "opencode-model-aliases.jsonc"),
      [
        "// Plugin configuration (JSONC): comments and trailing commas allowed.",
        "{",
        `  "aliases": {`,
        `    // The alias materializes the latest winner of the fake-* models.`,
        `    "${ALIAS_KEY}": {`,
        `      "match": "${PROVIDER}/fake-*",`,
        `      "select": { "strategy": "latest" },`,
        `    },`,
        `  },`,
        `  "strict": true,`,
        `  "debug": true,`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          autoupdate: false,
          model: ALIAS_KEY,
          plugins: [
            // No options: all configuration comes from the JSONC file.
            { package: pkgDir },
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

    if (INSPECT) {
      // Inspect mode: zero generation and zero session. First verify the REAL
      // shape of the `opencode api` command in the installed CLI (without
      // guessing it): it must accept `method path...` and `--data`.
      const help = await runSpawn("opencode", ["api", "--help"], {
        cwd: project,
        env,
        timeoutMs: 30_000,
      });
      const helpText = (help.stdout + help.stderr).trim();
      if (!helpText.includes("--data") || !helpText.includes("method path")) {
        throw new Error(
          `unexpected \`opencode api\` CLI shape; --help said:\n${helpText.slice(0, 400)}`,
        );
      }
      console.log("smoke:opencode: `opencode api` CLI shape verified (method path... + --data).");

      // Fire the plugin RPC through the host's real HTTP surface:
      // POST /api/rpc/<rpcID>/<method> with body {input:{}}.
      const api = await runSpawn(
        "opencode",
        [
          "api",
          "--standalone",
          "--print-logs",
          "post",
          "/api/rpc/opencode-model-aliases/inspect",
          "--data",
          JSON.stringify({ input: {} }),
        ],
        { cwd: project, env, timeoutMs: CLI_TIMEOUT_MS },
      );

      const problems = [];
      if (api.timedOut) {
        problems.push(
          `opencode api did not finish within ${CLI_TIMEOUT_MS / 1000}s (group killed)`,
        );
      } else if (api.code !== 0) {
        problems.push(`opencode api exited with code ${api.code}`);
      }
      if (api.spawnError) problems.push(`spawning opencode failed: ${api.spawnError}`);

      // The RPC route success body is {output: <method output>}.
      let body = null;
      try {
        body = JSON.parse(api.stdout.trim());
      } catch {
        body = null;
      }
      const reportText = body?.output?.text;
      const reportRows = body?.output?.rows;
      if (typeof reportText !== "string" || !Array.isArray(reportRows)) {
        problems.push(
          `inspect response was not {output:{text:string,rows:array}}; raw (first 400): ${JSON.stringify(
            (api.stdout + api.stderr).slice(0, 400),
          )}`,
        );
      } else {
        // The provider section shows displayName→target pairs; the displayName
        // is generated by src/names.ts from the alias key's last segment.
        const aliasName = ALIAS_KEY.split("/").pop();
        // Must match the displayName build logic: "latest" → "Latest (alias)".
        const displayName = "Latest (alias)";
        if (!reportText.includes(`${PROVIDER}\n  ${displayName} (${aliasName})\n    → ${TARGET}`)) {
          problems.push(`inspect report did not show the active alias target; got:\n${reportText}`);
        }
        if (!reportText.includes("1 alias · 1 active")) {
          problems.push(`inspect report did not summarize one active alias; got:\n${reportText}`);
        }
        if (!reportText.includes("strategy: latest")) {
          problems.push("inspect report did not mention the latest strategy");
        }
        // The catalog id === wire modelID in this environment: no wire mention.
        if (reportText.includes("wire model ID") || reportText.includes("wire modelID")) {
          problems.push(
            "inspect report mentioned a wire modelID although catalog id === wire modelID",
          );
        }

        const matchedRow = reportRows.find((r) => r.key === ALIAS_KEY);
        if (!matchedRow) {
          problems.push(`inspect report rows did not include alias "${ALIAS_KEY}"`);
        } else {
          if (matchedRow.status !== "active") {
            problems.push(`expected row status "active", got "${matchedRow.status}"`);
          }
          if (matchedRow.provider !== PROVIDER) {
            problems.push(`expected row provider "${PROVIDER}", got "${matchedRow.provider}"`);
          }
          if (matchedRow.alias !== aliasName) {
            problems.push(`expected row alias "${aliasName}", got "${matchedRow.alias}"`);
          }
          // Required public primitive in the RPC schema: the report displayName
          // must equal the generated catalog label.
          if (matchedRow.displayName !== displayName) {
            problems.push(
              `expected row displayName "${displayName}", got "${matchedRow.displayName}"`,
            );
          }
          if (matchedRow.target !== TARGET && matchedRow.catalogID !== TARGET) {
            problems.push(
              `expected row target "${TARGET}", got "${matchedRow.target ?? matchedRow.catalogID}"`,
            );
          }
        }
      }

      // Explain the same packed product through the real host's RPC boundary.
      const explained = await runSpawn(
        "opencode",
        [
          "api",
          "--standalone",
          "post",
          "/api/rpc/opencode-model-aliases/explain",
          "--data",
          JSON.stringify({ input: { alias: ALIAS_KEY } }),
        ],
        { cwd: project, env, timeoutMs: CLI_TIMEOUT_MS },
      );
      let explanation;
      try {
        explanation = JSON.parse(explained.stdout).output;
      } catch {}
      const selected = explanation?.explanation?.candidates?.filter(
        (candidate) => candidate.outcome === "selected",
      );
      if (
        explained.code !== 0 ||
        explained.timedOut ||
        explained.spawnError ||
        explanation?.status !== "active" ||
        explanation?.explanation?.winner !== `${PROVIDER}/${TARGET}` ||
        selected?.length !== 1 ||
        selected[0]?.id !== `${PROVIDER}/${TARGET}` ||
        selected[0]?.reasons?.[0]?.code !== "newest-release"
      ) {
        problems.push(
          `explain RPC did not describe the actual latest winner (exit=${explained.code}): ${explained.stdout.slice(0, 3000)} ${explained.stderr
            .split("\n")
            .filter((line) => /error|invalid|Error/.test(line))
            .slice(0, 5)
            .join("\n")}`,
        );
      }
      if (JSON.stringify(explanation ?? {}).includes(DUMMY_KEY))
        problems.push("explain RPC exposed provider credentials");

      if (problems.length === 0) {
        const baseline = reportRows.find((row) => row.key === ALIAS_KEY);
        if (baseline.transition !== undefined)
          problems.push("first resolution produced a false transition");
        // Restart two standalone hosts under the same isolated HOME/location.
        // Changing release metadata makes fake-small win without changing policy.
        const catalog = JSON.parse(await readFile(path.join(dir, "models.json"), "utf8"));
        catalog[PROVIDER].models["fake-small"].release_date = "2026-01-01";
        await writeFile(path.join(dir, "models.json"), JSON.stringify(catalog));
        const consumerFile = path.join(consumerDir, "index.js");
        await writeFile(
          consumerFile,
          (await readFile(consumerFile, "utf8")).replaceAll("fake-large", "fake-small"),
        );
        let transitionID;
        for (let restart = 0; restart < 2; restart++) {
          const result = await runSpawn(
            "opencode",
            [
              "api",
              "--standalone",
              "post",
              "/api/rpc/opencode-model-aliases/inspect",
              "--data",
              JSON.stringify({ input: {} }),
            ],
            { cwd: project, env, timeoutMs: CLI_TIMEOUT_MS },
          );
          if (result.code !== 0 || result.timedOut || result.spawnError) {
            problems.push(`history restart ${restart} failed: ${result.stderr.slice(-1500)}`);
            continue;
          }
          let row;
          try {
            row = JSON.parse(result.stdout).output.rows.find((value) => value.key === ALIAS_KEY);
          } catch {}
          const change = row?.transition;
          if (
            row?.status !== "active" ||
            row?.target !== "fake-small" ||
            change?.from !== `${PROVIDER}/fake-large` ||
            change?.to !== `${PROVIDER}/fake-small` ||
            !Number.isFinite(Date.parse(change?.changedAt ?? ""))
          ) {
            problems.push(
              `history restart ${restart} did not preserve confirmed A → B: ${JSON.stringify(row)}`,
            );
          }
          if (restart === 0) transitionID = change?.id;
          else if (!transitionID || change?.id !== transitionID)
            problems.push("unchanged restart repeated the transition");
        }
        console.log(
          "smoke:opencode: native storage and transition identity verified across restarts.",
        );
      }

      // The sink counts EVERY provider request: zero after this bounded
      // observation (the subprocess finished); inspecting runs no sessions.
      if (requests.length !== 0) {
        const seen = requests.map((r) => `${r.method} ${r.pathname}`).join(", ");
        problems.push(
          `expected 0 provider requests in inspect mode, observed ${requests.length}: ${seen}`,
        );
      }
      if (/failed to load plugin/.test(api.stderr)) {
        problems.push('host logged "failed to load plugin"');
      }
      const SENTINEL =
        "smoke-catalog-consumer: catalog OK providerID=localfake id=latest enabled=true modelID=fake-large";
      if (!api.stderr.includes(SENTINEL)) {
        problems.push(`stderr did not contain the consumer catalog sentinel "${SENTINEL}"`);
      }

      if (problems.length > 0) {
        console.error("smoke:opencode (inspect): FAILED");
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error("--- stdout (last 3000 chars) ---");
        console.error(api.stdout.slice(-3000) || "(empty)");
        console.error("--- stderr (last 3000 chars) ---");
        console.error(api.stderr.slice(-3000) || "(empty)");
        throw new Error(`smoke:opencode (inspect): FAILED with ${problems.length} problem(s)`);
      }

      console.log("smoke:opencode (inspect): PASSED");
      console.log(`  report: ${reportText.split("\n").join(" | ")}`);
      console.log(`  provider requests observed: ${requests.length}`);
    } else {
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
        problems.push(
          `opencode run did not finish within ${CLI_TIMEOUT_MS / 1000}s (group killed)`,
        );
      } else if (run.code !== 0) {
        problems.push(`opencode run exited with code ${run.code}`);
      }
      if (run.spawnError) problems.push(`spawning opencode failed: ${run.spawnError}`);

      // Assistant text event, exactly "pong", from stdout JSON.
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
        (event) =>
          event.type === "text" && event.part?.type === "text" && event.part.text === "pong",
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
          .filter((line) => /opencode-model-aliases|smoke-catalog-consumer|debug/.test(line));
        console.error("--- plugin-relevant stderr lines ---");
        console.error(interesting.join("\n") || "(none)");
        // Throw instead of exit: the finally closes the server and removes the temp.
        throw new Error(`smoke:opencode: FAILED with ${problems.length} problem(s)`);
      }

      console.log("smoke:opencode: PASSED");
      console.log(
        `  alias ${ALIAS_KEY} materialized as ${PROVIDER}/${TARGET} (catalog + wire model)`,
      );
      console.log(`  chat requests observed: ${chatRequests.length}`);
      console.log("  assistant text event: pong (exact match)");
    }
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
