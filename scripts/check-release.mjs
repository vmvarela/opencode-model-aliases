#!/usr/bin/env node
// Comprobaciones offline del flujo de release. No publica, no consulta
// remotos, no ejecuta semanticRelease (tampoco en modo dry-run, que haría
// fetch/push de prueba e intercambio OIDC). Solo lectura más `npm pack
// --dry-run`, que no envía nada al registro.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

// Versiones mínimas garantizadas por el dependency-bundling de
// semantic-release 25.0.9 (sin declarar los plugins como deps directas).
const MIN_PLUGIN_VERSIONS = {
  "@semantic-release/commit-analyzer": [13, 0, 1],
  "@semantic-release/release-notes-generator": [14, 1, 0],
  "@semantic-release/npm": [13, 1, 1],
  "@semantic-release/github": [12, 0, 0],
};

const step = async (label, run) => {
  await run();
  console.log(`check:release: ok — ${label}`);
};

const readFileSyncOrNull = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};
const packageDirFor = (resolved) => {
  let dir = path.dirname(resolved);
  while (dir !== path.dirname(dir) && !readFileSyncOrNull(path.join(dir, "package.json"))) {
    dir = path.dirname(dir);
  }
  return dir;
};

// Los plugins van instalados transitivamente por semantic-release: solo son
// resolvibles desde su propio entry point, no desde la raíz del proyecto.
const pluginRequire = createRequire(
  createRequire(path.join(ROOT, "package.json")).resolve("semantic-release"),
);
const loadPlugin = (name) => {
  const packageDir = packageDirFor(pluginRequire.resolve(name));
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const module = import(pathToFileURL(path.join(packageDir, manifest.main ?? "index.js")).href);
  return { manifest, module };
};
const atLeast = (actual, minimum) => {
  const [maj, min, pat] = minimum;
  assert.ok(
    actual[0] > maj ||
      (actual[0] === maj && actual[1] > min) ||
      (actual[0] === maj && actual[1] === min && actual[2] >= pat),
    `versión ${actual.join(".")} debe ser >= ${minimum.join(".")}`,
  );
};

const FAKE_LOGGER = Object.fromEntries(
  ["error", "info", "warn", "debug", "log", "success"].map((level) => [level, () => {}]),
);
const commits = (messages) =>
  messages.map((message, index) => ({
    message,
    hash: `h${index}`,
    committerDate: "2026-01-01T00:00:00.000Z",
    committerName: "test",
  }));

const releaseConfig = readJson(".releaserc.json");
const packageManifest = readJson("package.json");
const workflow = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");

// El preset conventionalcommits solo parsea los footers listados en
// noteKeywords; al sobreescribirlos hay que incluir el plural
// ("BREAKING CHANGES") además del singular y "BREAKING-CHANGE".
const BREAKING_NOTE_KEYWORDS = ["BREAKING CHANGE", "BREAKING CHANGES", "BREAKING-CHANGE"];
const conventionalPresetConfig = {
  preset: "conventionalcommits",
  parserOpts: { noteKeywords: BREAKING_NOTE_KEYWORDS },
};

// --- Config de release y metadatos del paquete -------------------------------
await step("config .releaserc.json y metadatos package.json", () => {
  assert.deepEqual(releaseConfig.branches, ["master"]);
  assert.ok(!("tagFormat" in releaseConfig) || releaseConfig.tagFormat === `v\${version}`);
  assert.deepEqual(releaseConfig.plugins[0], [
    "@semantic-release/commit-analyzer",
    conventionalPresetConfig,
  ]);
  assert.deepEqual(releaseConfig.plugins[1], [
    "@semantic-release/release-notes-generator",
    conventionalPresetConfig,
  ]);
  assert.deepEqual(releaseConfig.plugins[2], ["@semantic-release/npm", { npmPublish: true }]);
  assert.deepEqual(releaseConfig.plugins[3], [
    "@semantic-release/github",
    {
      successComment: false,
      failComment: false,
      failTitle: false,
      labels: false,
      releasedLabels: false,
    },
  ]);
  // Sin plugin de git ni changelog escrito en master: las notas de GitHub
  // release sirven de changelog.
  for (const plugin of releaseConfig.plugins) {
    const [name] = Array.isArray(plugin) ? plugin : [plugin];
    assert.notEqual(name, "@semantic-release/git");
    assert.ok(!name.includes("CHANGELOG"));
  }

  assert.equal(packageManifest.version, "0.1.0");
  assert.deepEqual(packageManifest.repository, {
    type: "git",
    url: "git+https://github.com/vmvarela/opencode-model-aliases.git",
  });
  assert.deepEqual(packageManifest.publishConfig, { access: "public" });
  assert.deepEqual(packageManifest.devDependencies["semantic-release"], "25.0.9");
  // Preset de Conventional Commits con pin exacto: 10.x es incompatible con el
  // writer transitivo que empaqueta semantic-release 25.0.9.
  assert.deepEqual(
    packageManifest.devDependencies["conventional-changelog-conventionalcommits"],
    "9.3.1",
  );
  const semanticReleaseDirectDeps = Object.keys({
    ...packageManifest.dependencies,
    ...packageManifest.devDependencies,
  }).filter((name) => name.startsWith("@semantic-release/"));
  assert.deepEqual(semanticReleaseDirectDeps, []);
  assert.ok(
    !Object.keys(packageManifest.scripts).some((key) =>
      /publish/i.test(`${key}${packageManifest.scripts[key]}`),
    ),
  );
});

// --- Workflow de publicación manual ------------------------------------------
await step("workflow release.yml: compuerta, permisos y credenciales", () => {
  assert.match(workflow, /github\.repository == 'vmvarela\/opencode-model-aliases'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /^on:\s*\n {2}workflow_dispatch:\s*\n\npermissions:/m);
  assert.ok(!workflow.includes("NPM_RELEASE_ENABLED"));
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.ok(!/issues: write|pull-requests: write/.test(workflow));
  assert.match(workflow, /actions\/checkout@v[67]/);
  assert.match(workflow, /actions\/setup-node@v[67]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm install --global npm@11\.6\.2/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm run verify/);
  assert.match(workflow, /pnpm run check:release/);
  assert.match(workflow, /pnpm exec semantic-release/);
  assert.ok(!/npm publish|pnpm publish/.test(workflow));
  // Única referencia a secretos: el GITHUB_TOKEN que trae Actions.
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(!workflow.includes("NPM_TOKEN"));
  assert.ok(!workflow.includes("NODE_AUTH_TOKEN"));
});

// --- Plugins resueltos realmente instalados ----------------------------------
const plugins = Object.fromEntries(
  Object.keys(MIN_PLUGIN_VERSIONS).map((name) => [name, loadPlugin(name)]),
);

await step("plugins empaquetados con semantic-release, versiones mínimas", () => {
  for (const [name, minimum] of Object.entries(MIN_PLUGIN_VERSIONS)) {
    assert.equal(plugins[name].manifest.name, name);
    atLeast(plugins[name].manifest.version.split(".").map(Number), minimum);
  }
});

const { analyzeCommits } = await plugins["@semantic-release/commit-analyzer"].module;
const analyzerConfig = releaseConfig.plugins[0][1];
await step("commit-analyzer analyzeCommits sobre fixtures sintéticas", async () => {
  const cases = [
    { messages: ["feat!: rompe API"], expected: "major" },
    { messages: ["fix!: rompe todo"], expected: "major" },
    { messages: ["feat(core)!: rompe el núcleo"], expected: "major" },
    { messages: ["feat: algo\n\nBREAKING CHANGE: rompe API"], expected: "major" },
    { messages: ["feat: algo\n\nBREAKING CHANGES: rompe API"], expected: "major" },
    { messages: ["feat: agrega una cosa"], expected: "minor" },
    { messages: ["fix: corrige un fallo"], expected: "patch" },
    { messages: ["perf: acelera el arranque"], expected: "patch" },
    { messages: ["feat: a", "fix: b", "chore: c", "docs: d"], expected: "minor" },
    { messages: ["chore: deps", "docs: readme", "test: mocks"], expected: null },
  ];
  for (const { messages, expected } of cases) {
    const releaseType = await analyzeCommits(analyzerConfig, {
      commits: commits(messages),
      logger: FAKE_LOGGER,
      cwd: ROOT,
    });
    assert.equal(releaseType, expected, `${JSON.stringify(messages)} → ${String(expected)}`);
  }
});

const { generateNotes } = await plugins["@semantic-release/release-notes-generator"].module;
const notesConfig = releaseConfig.plugins[1][1];
await step("release-notes-generator generateNotes sobre fixtures con breaking", async () => {
  const notes = await generateNotes(notesConfig, {
    commits: commits([
      "feat!: rompe el contrato",
      "fix(core)!: rompe el núcleo\n\nBREAKING CHANGES: detalla el rompimiento",
      "feat: agrega thing",
      "fix: arregla detalle",
    ]),
    logger: FAKE_LOGGER,
    cwd: ROOT,
    lastRelease: { version: "1.0.0", gitTag: "v1.0.0", gitHead: "h0" },
    nextRelease: { version: "2.0.0", gitTag: "v2.0.0", gitHead: "h1" },
    options: { repositoryUrl: "https://github.com/vmvarela/opencode-model-aliases.git" },
  });
  const text = String(notes);
  // El heading real es "### ⚠ BREAKING CHANGES": sin incluir el emoji.
  const breakingIndex = text.indexOf("BREAKING CHANGES");
  const featuresIndex = text.indexOf("### Features");
  for (const expected of [
    "BREAKING CHANGES",
    "### Features",
    "agrega thing",
    "/compare/v1.0.0...v2.0.0",
  ]) {
    assert.ok(text.includes(expected), `notas sin ${JSON.stringify(expected)}`);
  }
  // La sección de breaking va primero y recoge tanto el `!` del header como
  // el footer en plural.
  assert.ok(
    breakingIndex !== -1 && breakingIndex < featuresIndex,
    "sección BREAKING CHANGES ausente o fuera de orden",
  );
  const breakingSection = featuresIndex === -1 ? "" : text.slice(breakingIndex, featuresIndex);
  assert.ok(
    breakingSection.includes("rompe el contrato"),
    "el breaking por header `!` no aparece en la sección BREAKING CHANGES",
  );
  assert.ok(
    breakingSection.includes("detalla el rompimiento"),
    "el footer BREAKING CHANGES plural no aparece en la sección BREAKING CHANGES",
  );
});

// Interfaces de publicación presentes pero nunca invocadas desde aquí.
const npmPlugin = await plugins["@semantic-release/npm"].module;
const githubPlugin = await plugins["@semantic-release/github"].module;
assert.deepEqual(Object.keys(npmPlugin).sort(), [
  "addChannel",
  "prepare",
  "publish",
  "verifyConditions",
]);
assert.equal(typeof githubPlugin.publish, "function");
assert.equal(typeof githubPlugin.success, "function");
console.log("check:release: ok — interfaces npm/github presentes (sin invocarlas)");

// --- Inventario del tarball: solo files de la whitelist ----------------------
const packOutput = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
);
// npm 11 emitte un array de paquetes (solo el paquete local).
assert.ok(Array.isArray(packOutput) && packOutput.length === 1, "pack inesperado");
assert.equal(packOutput[0].name, "opencode-model-aliases");
const packedFiles = packOutput[0].files.map((entry) => entry.path);
// package.json va siempre en el tarball de npm además de la lista files.
const allowedRoots = ["index.js", "tui.js", "dist", "README.md", "LICENSE", "package.json"];
const leaked = packedFiles.filter((file) => {
  return !allowedRoots.some((root) => file === root || file.startsWith(`${root}/`));
});
assert.ok(packedFiles.length > 0, "inventario vacío; corre pnpm run build primero");
assert.deepEqual(leaked, [], `archivos fuera de files en el tarball: ${JSON.stringify(leaked)}`);
for (const required of [
  "index.js",
  "tui.js",
  "dist/index.js",
  "dist/tui.js",
  "README.md",
  "LICENSE",
]) {
  assert.ok(packedFiles.includes(required), `falta ${required} en el tarball`);
}
console.log(`check:release: ok — npm pack --dry-run (${packedFiles.length} archivos, sin fugas)`);
console.log("check:release: PASSED (offline)");
