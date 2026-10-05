import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPlainObject } from "../src/config.js";
import { loadConfigFile } from "../src/config-file.js";
import floatingModels from "../src/index.js";
import { makeTempRoot, removeTempRoot, writeConfigFile } from "./config-fs.js";
import { createHarness, sourceModel } from "./harness.js";

const SOURCES = () => [
  sourceModel({ id: "claude-a", providerID: "anthropic", released: 1_000 }),
  sourceModel({ id: "claude-b", providerID: "anthropic", released: 2_000 }),
];

let tempRoot: string;
let warnings: string[];

beforeEach(() => {
  tempRoot = makeTempRoot();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoot(tempRoot);
});

describe("separate JSONC config file", () => {
  it("file-only options con comentarios y trailing commas: alias, strict y debug aplican", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      project,
      [
        "// Plugin configuration, with comments and trailing commas.",
        "{",
        '  "aliases": {',
        '    "anthropic/float": { "match": ["anthropic/claude-*"] }, // trailing comma',
        "  },",
        '  "strict": true,',
        '  "debug": true,',
        "}",
      ].join("\n"),
    );
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await floatingModels.setup(harness.ctx);
    harness.view();
    // Default latest strategy: claude-b (released 2000) wins.
    expect(harness.view().get("anthropic/float")?.modelID).toBe("claude-b");
    // debug:true comes from the file.
    expect(warnings.some((w) => w.includes("[opencode-model-aliases] [debug]"))).toBe(true);

    // strict:true from the file: an unresolved alias rejects the setup.
    const strictDir = path.join(tempRoot, "strict");
    mkdirSync(strictDir, { recursive: true });
    writeConfigFile(
      strictDir,
      '{ "aliases": { "anthropic/void": { "match": "anthropic/none*" } }, "strict": true }',
    );
    const strict = createHarness({ sources: SOURCES(), directory: strictDir });
    await expect(floatingModels.setup(strict.ctx)).rejects.toThrow(/strict/);
    expect(strict.callbacks).toHaveLength(0);
  });

  it("sin archivo, las options inline funcionan igual que antes", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    const harness = createHarness({
      sources: SOURCES(),
      options: { aliases: { "anthropic/float": { match: "anthropic/claude-*" } } },
      directory: project,
    });
    await floatingModels.setup(harness.ctx);
    expect(harness.view().get("anthropic/float")?.modelID).toBe("claude-b");
  });

  it("strict/debug inline con false prevalecen sobre el archivo (el false se respeta)", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      project,
      '{ "aliases": { "anthropic/void": { "match": "anthropic/none*" }, "anthropic/good": { "match": "anthropic/**" } }, "strict": true, "debug": true }',
    );
    const harness = createHarness({
      sources: SOURCES(),
      options: { strict: false },
      directory: project,
    });
    // Inline false overrides the file's true: tolerant setup resolves.
    await expect(floatingModels.setup(harness.ctx)).resolves.toBeTypeOf("function");
    // The unresolved alias warns in tolerant mode...
    expect(warnings.some((w) => w.includes('alias "anthropic/void" unresolved'))).toBe(true);
    // ...and debug:true still comes from the file for the resolved alias.
    expect(warnings.some((w) => w.includes('alias "anthropic/good"'))).toBe(true);
    expect(warnings.some((w) => w.includes("[debug]"))).toBe(true);
  });

  it("aliases: union por clave y el registro inline reemplaza el completo del archivo", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      project,
      [
        "{",
        '  "aliases": {',
        '    "anthropic/only-file": { "match": "anthropic/**" },',
        '    "anthropic/both": { "match": "anthropic/**", "name": "Del archivo" },',
        "  },",
        "}",
      ].join("\n"),
    );
    const harness = createHarness({
      sources: SOURCES(),
      options: {
        aliases: {
          "anthropic/both": { match: "anthropic/claude-a" }, // full replacement
          "anthropic/only-inline": { match: "anthropic/claude-b" },
        },
      },
      directory: project,
    });
    await floatingModels.setup(harness.ctx);
    const view = harness.view();
    // From the file.
    expect(view.get("anthropic/only-file")?.modelID).toBe("claude-b");
    // Inline: full replacement of the record (no name inherited from the file).
    expect(view.get("anthropic/both")?.modelID).toBe("claude-a");
    expect(view.get("anthropic/both")?.name).toBe("Both (alias)");
    // Inline-only.
    expect(view.get("anthropic/only-inline")?.modelID).toBe("claude-b");
  });

  it("no muta las options inline ni los registros del archivo", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    const fileAliases = {
      "anthropic/float": { match: "anthropic/**", name: "Del archivo" },
    };
    writeConfigFile(project, JSON.stringify({ aliases: fileAliases }));
    const inlineAliases: Record<string, unknown> = {
      "anthropic/float": Object.freeze({ match: "anthropic/claude-a" }),
    };
    const inlineOptions = Object.freeze({ aliases: Object.freeze(inlineAliases) });
    const harness = createHarness({ sources: SOURCES(), directory: project });
    (harness.ctx as { options: unknown }).options = inlineOptions;
    await floatingModels.setup(harness.ctx);
    // Frozen objects: any mutation would have thrown or altered keys.
    expect(Object.keys(inlineOptions)).toEqual(["aliases"]);
    expect(Object.keys(inlineAliases)).toEqual(["anthropic/float"]);
    expect(Object.isFrozen(inlineOptions.aliases)).toBe(true);
    // The materialized alias uses the complete inline record.
    expect(harness.view().get("anthropic/float")?.name).toBe("Float (alias)");
    expect(harness.view().get("anthropic/float")?.modelID).toBe("claude-a");
  });

  it("el archivo más cercano gana y se ignora el ancestral", async () => {
    const root = path.join(tempRoot, "workspace");
    const nested = path.join(root, "nested");
    mkdirSync(nested, { recursive: true });
    writeConfigFile(root, '{ "aliases": { "anthropic/from-root": { "match": "anthropic/**" } } }');
    writeConfigFile(
      nested,
      '{ "aliases": { "anthropic/from-nested": { "match": "anthropic/**" } } }',
    );
    const harness = createHarness({ sources: SOURCES(), directory: nested });
    await floatingModels.setup(harness.ctx);
    expect(harness.view().get("anthropic/from-nested")).toBeDefined();
    expect(harness.view().get("anthropic/from-root")).toBeUndefined();
  });

  it("el lookup ancestral cruza la frontera de un repo anidado (.git)", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const repo = path.join(workspace, "repo");
    const project = path.join(repo, "sub");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      workspace,
      '{ "aliases": { "anthropic/from-workspace": { "match": "anthropic/**" } } }',
    );
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await floatingModels.setup(harness.ctx);
    expect(harness.view().get("anthropic/from-workspace")?.modelID).toBe("claude-b");
  });

  it("JSONC malformado (aunque el parser recupere datos) rechaza el setup sin registrar", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    // Missing object close: the tolerant parser recovers partial data
    // but reports errors, and those errors must fail.
    writeConfigFile(project, '{ "aliases": { "anthropic/float": { "match": "anthropic/**" } }');
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/malformed JSONC/);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("loadConfigFile reporta código y offset del error de parseo, sin volcar el contenido", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    const secret = "sk-super-secret-value";
    writeConfigFile(project, `{ "aliases": { "anthropic/float": { "token": "${secret}" } }`);
    const result = await loadConfigFile(project);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/malformed JSONC: \w+ at offset \d+/);
    expect(result.reason).not.toContain(secret);
  });

  it("raíz y aliases con contenedor inválido fallan", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(project, "[1, 2, 3]");
    const arrayRoot = await loadConfigFile(project);
    expect(arrayRoot.ok).toBe(false);
    if (!arrayRoot.ok) expect(arrayRoot.reason).toMatch(/JSONC object at the root/);

    writeConfigFile(project, '{ "aliases": null }');
    const nullAliases = await loadConfigFile(project);
    expect(nullAliases.ok).toBe(false);
    if (!nullAliases.ok) expect(nullAliases.reason).toMatch(/aliases must be an object/);

    writeConfigFile(project, '{ "aliases": ["x"] }');
    const arrayAliases = await loadConfigFile(project);
    expect(arrayAliases.ok).toBe(false);
  });

  it("archivo ausente sin aliases inline: mismo fallo de antes, sin registrar", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    const harness = createHarness({ directory: project });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(
      /aliases must be an object \(\{\} is a valid no-op\)/,
    );
    expect(harness.callbacks).toHaveLength(0);
  });

  it("archivo ilegible (EISDIR) falla en vez de seguir hacia un archivo ancestral", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const project = path.join(workspace, "proj");
    mkdirSync(path.join(project, ".opencode", "opencode-model-aliases.jsonc"), {
      recursive: true,
    });
    writeConfigFile(
      workspace,
      '{ "aliases": { "anthropic/from-workspace": { "match": "anthropic/**" } } }',
    );
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/could not be read.*EISDIR/s);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("archivo sin permisos (EACCES) falla con ruta y código", async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod; skip in that case
    const project = path.join(tempRoot, "proj");
    const file = writeConfigFile(project, "{ }");
    chmodSync(file, 0o000);
    const result = await loadConfigFile(project);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/could not be read \(code: EACCES\)/);
      expect(result.reason).toContain(file);
    }
  });

  it("sin archivo en toda la ancestria, loadConfigFile resuelve vacío", async () => {
    const project = path.join(tempRoot, "deep", "deeper");
    mkdirSync(project, { recursive: true });
    const result = await loadConfigFile(project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file).toBeUndefined();
  });

  it("loadConfigFile devuelve objetos crudos validados como contenedores", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      project,
      '{ "aliases": { "anthropic/float": { "match": "anthropic/**" } }, "strict": true, "unknown": 1 }',
    );
    const result = await loadConfigFile(project);
    expect(result.ok).toBe(true);
    if (result.ok && result.file) {
      expect(isPlainObject(result.file.options.aliases)).toBe(true);
      expect(result.file.options.strict).toBe(true);
      // Unknown root keys are preserved in the raw options:
      // normalizeOptions will reject them as parse-error.
      expect(result.file.options.unknown).toBe(1);
      expect(
        result.file.path.endsWith(path.join(".opencode", "opencode-model-aliases.jsonc")),
      ).toBe(true);
    }
  });

  it("una errata en la raíz del archivo (strcit) falla el setup sin registrar callbacks", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(
      project,
      '{ "aliases": { "anthropic/float": { "match": "anthropic/**" } }, "strcit": true }',
    );
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/strcit/);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("el RPC inspect expone el alias definido solo en el archivo", async () => {
    const project = path.join(tempRoot, "proj");
    mkdirSync(project, { recursive: true });
    writeConfigFile(project, '{ "aliases": { "anthropic/float": { "match": "anthropic/**" } } }');
    const harness = createHarness({ sources: SOURCES(), directory: project });
    await floatingModels.setup(harness.ctx);
    // A single RPC registration with the contract's definition.
    expect(harness.rpc.definitions).toHaveLength(1);
    expect(harness.rpc.registrations[0]?.disposed).toBe(false);
    const text = await harness.inspect();
    // Provider section with the exact alias→target pair.
    expect(text).toContain("anthropic\n  Float (alias) (float)\n    → claude-b");
    // Active status is summarized in the header, not per alias.
    expect(text).toContain("1 alias · 1 active");
  });
});
