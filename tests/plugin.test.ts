import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import floatingModels from "../src/index.js";
import { makeTempRoot, removeTempRoot, writeConfigFile } from "./config-fs.js";
import { createHarness as baseHarness, type ModelInfo, sourceModel } from "./harness.js";

/**
 * Local wrapper: the harness default directory is the test temporary
 * root (never the real repo).
 */
function createHarness(input: Parameters<typeof baseHarness>[0] = {}) {
  return baseHarness({ ...input, directory: input.directory ?? tempRoot });
}

const DEFAULT_SOURCES = () => [
  sourceModel({ id: "claude-a", providerID: "anthropic", name: "Claude A", released: 1_000 }),
  sourceModel({ id: "claude-b", providerID: "anthropic", name: "Claude B", released: 2_000 }),
  sourceModel({
    id: "sonnet-4",
    providerID: "github-copilot",
    name: "Sonnet",
    modelID: "sonnet-4-exec",
    released: 3_000,
    package: "copilot-sonnet",
    canonical: "anthropic/claude-sonnet-4",
  }),
];

const SIMPLE_OPTIONS = () => ({
  aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
});

let warnings: string[];
let debugs: string[];
let tempRoot: string;

beforeEach(() => {
  tempRoot = makeTempRoot();
  warnings = [];
  debugs = [];
  vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
  vi.spyOn(console, "debug").mockImplementation((message) => {
    debugs.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoot(tempRoot);
});

describe("opencode-model-aliases plugin", () => {
  it("configuración malformada falla antes de registrar el transform", async () => {
    const harness = createHarness({ options: { aliases: "x" } });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/invalid configuration/);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("una errata en la raíz inline (strcit) falla antes de registrar callbacks", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
        strcit: true,
      },
    });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/strcit/);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("expone el alias a un consumidor posterior tras el registro", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(harness.ctx);
    let consumerView: ModelInfo[] = [];
    await harness.ctx.model.transform((hostEditor) => {
      consumerView = (hostEditor as unknown as { list: () => ModelInfo[] }).list();
    });
    harness.replay();
    const alias = consumerView.find((m) => m.providerID === "github-copilot" && m.id === "sonnet");
    expect(alias).toBeDefined();
    expect(alias?.name).toBe("Sonnet (alias)");
  });

  it("mantiene id estable, name por defecto y el modelID de ejecución del ganador", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const alias = harness.view().get("github-copilot/sonnet");
    expect(alias?.id).toBe("sonnet");
    expect(alias?.modelID).toBe("sonnet-4-exec");
    expect(alias?.providerID).toBe("github-copilot");
    expect(alias?.name).toBe("Sonnet (alias)");
  });

  it("name configurado se usa intacto aunque coincida con la clave", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        aliases: {
          "github-copilot/sonnet": { match: "github-copilot/**", name: "github-copilot/sonnet" },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("github-copilot/sonnet")?.name).toBe("github-copilot/sonnet");
  });

  it("el name del catálogo y el displayName del informe coinciden para name explícito y generado", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        aliases: {
          "github-copilot/sonnet": { match: "github-copilot/**", name: "Sonnet (floating)" },
          "anthropic/pick": { match: "anthropic/**" },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const explicit = harness.view().get("github-copilot/sonnet");
    const generated = harness.view().get("anthropic/pick");
    expect(explicit?.name).toBe("Sonnet (floating)"); // intact name in Model.Info
    expect(generated?.name).toBe("Pick (alias)"); // same rule as the report

    const handler = harness.rpc.handlers[0]?.inspect;
    if (!handler) throw new Error("inspect handler missing");
    const result = (await handler({}, {})) as {
      rows: Array<{ key: string; displayName: string }>;
    };
    const byKey = new Map(result.rows.map((row) => [row.key, row.displayName]));
    expect(byKey.get("github-copilot/sonnet")).toBe("Sonnet (floating)");
    expect(byKey.get("anthropic/pick")).toBe("Pick (alias)");
  });

  it("modelID con barra: catálogo e informe generan el mismo nombre y mantienen el modelID de ejecución", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: { aliases: { "anthropic/claude/float": { match: "anthropic/**" } } },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const alias = harness.view().get("anthropic/claude/float");
    expect(alias?.name).toBe("Float (alias)"); // last segment of "claude/float"

    const handler = harness.rpc.handlers[0]?.inspect;
    if (!handler) throw new Error("inspect handler missing");
    const result = (await handler({}, {})) as {
      text: string;
      rows: Array<{ key: string; displayName: string }>;
    };
    expect(result.rows[0]?.key).toBe("anthropic/claude/float");
    expect(result.rows[0]?.displayName).toBe("Float (alias)");
    expect(result.text).toContain("Float (alias) (claude/float)\n    → claude-b");
  });

  it("hereda package, canonical, settings, headers, body, capabilities, variants, cost y limit", async () => {
    const rich = sourceModel({
      id: "sonnet-4",
      providerID: "github-copilot",
      name: "Sonnet",
      released: 3_000,
      package: "copilot-sonnet",
      canonical: "anthropic/claude-sonnet-4",
      settings: { compaction: { type: "summary" }, extra: 1 },
      headers: { "x-hint": "cache" },
      body: { temperature: 0.7 },
      compatibility: { requireReasoning: true },
      capabilities: { tools: false, input: ["image"], output: ["text"] },
      variants: [{ id: "v1" }],
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      limit: { context: 180_000, input: 170_000, output: 8_000 },
    });
    const harness = createHarness({
      sources: [rich],
      options: SIMPLE_OPTIONS(),
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const alias = harness.view().get("github-copilot/sonnet");
    expect(alias?.package).toBe("copilot-sonnet");
    expect(alias?.canonical).toBe("anthropic/claude-sonnet-4");
    expect(alias?.settings).toEqual({ compaction: { type: "summary" }, extra: 1 });
    expect(alias?.headers).toEqual({ "x-hint": "cache" });
    expect(alias?.body).toEqual({ temperature: 0.7 });
    expect(alias?.compatibility).toEqual({ requireReasoning: true });
    expect(alias?.capabilities).toEqual({ tools: false, input: ["image"], output: ["text"] });
    expect(alias?.variants).toEqual([{ id: "v1" }]);
    expect(alias?.cost).toEqual([{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]);
    expect(alias?.limit).toEqual({ context: 180_000, input: 170_000, output: 8_000 });
    expect(alias?.time).toEqual({ released: 3_000 });
  });

  it("los filtros de capabilities y minContext deciden la materialización del alias", async () => {
    const harness = createHarness({
      sources: [
        sourceModel({
          id: "new-small",
          providerID: "anthropic",
          name: "New small",
          released: 9_000,
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          limit: { context: 64_000, output: 8_192 },
        }),
        sourceModel({
          id: "old-compatible",
          providerID: "anthropic",
          name: "Old compatible",
          released: 1_000,
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          limit: { context: 200_000, output: 8_192 },
        }),
      ],
      options: {
        aliases: {
          "anthropic/tools": {
            match: "anthropic/**",
            filter: { capabilities: { tools: true } },
          },
          "anthropic/context": {
            match: "anthropic/**",
            filter: { minContext: 128_000 },
          },
          "anthropic/modalities": {
            match: "anthropic/**",
            filter: { capabilities: { input: ["image"] } },
          },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    // The newest incompatible source loses in every requirement dimension.
    expect(harness.view().get("anthropic/tools")?.modelID).toBe("old-compatible");
    expect(harness.view().get("anthropic/context")?.modelID).toBe("old-compatible");
    expect(harness.view().get("anthropic/modalities")?.modelID).toBe("old-compatible");
  });

  it("un alias sin candidatos con los requisitos configurados avisa con motivo determinista sin ids", async () => {
    const harness = createHarness({
      sources: [
        sourceModel({
          id: "claude-a",
          providerID: "anthropic",
          name: "Claude A",
          released: 1_000,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 200_000, output: 8_192 },
        }),
      ],
      options: {
        aliases: {
          "anthropic/audio": {
            match: "anthropic/**",
            filter: { capabilities: { input: ["audio"] } },
          },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("anthropic/audio")).toBeUndefined();
    const warning = warnings.find((w) => w.includes('"anthropic/audio"')) ?? "";
    expect(warning).toContain("unresolved");
    expect(warning).toContain(
      "no candidate satisfied all configured requirements " +
        "(unmet across the candidate set: capabilities.input includes [audio])",
    );
    // The reason never carries candidate identities or private metadata.
    expect(warning).not.toContain("claude-a");
  });

  it("el filtro por defecto excluye disabled y beta aunque sean más recientes", async () => {
    const harness = createHarness({
      sources: [
        sourceModel({ id: "old", providerID: "anthropic", name: "Old", released: 1_000 }),
        sourceModel({
          id: "beta-new",
          providerID: "anthropic",
          name: "Beta",
          status: "beta",
          released: 4_000,
        }),
        sourceModel({
          id: "disabled-new",
          providerID: "anthropic",
          name: "Off",
          enabled: false,
          released: 5_000,
        }),
      ],
      options: { aliases: { "anthropic/pick": { match: "anthropic/**" } } },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("anthropic/pick")?.modelID).toBe("old");
  });

  it("con un ganador más reciente el alias cambia de objetivo pero mantiene su name", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("github-copilot/sonnet")?.modelID).toBe("sonnet-4-exec");

    harness.addSource(
      sourceModel({
        id: "sonnet-5",
        providerID: "github-copilot",
        name: "Sonnet 5",
        released: 9_000,
      }),
    );
    harness.replay();
    expect(harness.view().get("github-copilot/sonnet")?.modelID).toBe("sonnet-5");
    // The visible identity does not depend on the winner's name.
    expect(harness.view().get("github-copilot/sonnet")?.name).toBe("Sonnet (alias)");
  });

  it("si el objetivo desaparece, el alias se omite con aviso en modo tolerante", async () => {
    const only = sourceModel({ id: "solo", providerID: "anthropic", name: "Solo", released: 100 });
    const harness = createHarness({
      sources: [only],
      options: { aliases: { "anthropic/float": { match: "anthropic/**" } } },
    });
    await floatingModels.setup(harness.ctx);
    expect(harness.view().get("anthropic/float")).toBeDefined();

    harness.removeSource("anthropic", "solo");
    harness.replay();
    // The derived state is rebuilt from the source: no residual alias.
    expect(harness.view().get("anthropic/float")).toBeUndefined();
    const warning = warnings.find((w) => w.includes('"anthropic/float"')) ?? "";
    expect(warning).toContain("unresolved");
  });

  it("un modelo fuente que aparece después con el id del alias dispara la colisión", async () => {
    const harness = createHarness({
      sources: [sourceModel({ id: "solo", providerID: "anthropic", name: "Solo", released: 100 })],
      options: { aliases: { "anthropic/float": { match: "anthropic/**" } } },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("anthropic/float")).toBeDefined();

    harness.addSource(
      sourceModel({ id: "float", providerID: "anthropic", name: "Ahora soy fuente", released: 9 }),
    );
    expect(() => harness.replay()).toThrow(/configuration collision/);
    // The source model was not suppressed nor replaced.
    const untouched = harness.view().get("anthropic/float");
    expect(untouched?.name).toBe("Ahora soy fuente");
    expect(untouched?.time.released).toBe(9);
  });

  it("strict sin resolver: el host traga el fallo y setup rechaza, con registro separado", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        strict: true,
        aliases: {
          "github-copilot/ok": { match: "github-copilot/**" },
          "anthropic/void": { match: "anthropic/nonexistent*" },
        },
      },
    });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(
      /strict: unresolved aliases.*anthropic\/void \(no-eligible\)/s,
    );
    // The transform was detached even though the host's list() resolved.
    expect(harness.callbacks).toHaveLength(0);
    // The source catalog remains intact.
    expect(harness.view().get("anthropic/claude-b")?.name).toBe("Claude B");
    expect(harness.view().get("github-copilot/sonnet-4")?.name).toBe("Sonnet");
    expect(harness.view().get("github-copilot/ok")).toBeUndefined();
    expect(harness.view().get("anthropic/void")).toBeUndefined();
  });

  it("colisión inicial: setup rechaza pese al list() que traga el fallo", async () => {
    const harness = createHarness({
      sources: [
        sourceModel({ id: "claude-a", providerID: "anthropic", name: "Claude A", enabled: false }),
      ],
      options: { aliases: { "anthropic/claude-a": { match: "anthropic/**" } } },
    });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/configuration collision/);
    expect(harness.callbacks).toHaveLength(0);
    const untouched = harness.view().get("anthropic/claude-a");
    expect(untouched?.name).toBe("Claude A");
    expect(untouched?.enabled).toBe(false);
    expect(untouched?.id).toBe("claude-a");
  });

  it("fallo del host en el primer list() tras el registro: dispose y rethrow", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    harness.failNextList(new Error("host down"));
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/host down/);
    expect(harness.callbacks).toHaveLength(0);
  });

  it("un fallo posterior deshabilita el transform mientras list() resuelve", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(harness.ctx);
    expect(harness.view().get("github-copilot/sonnet")?.modelID).toBe("sonnet-4-exec");

    // A provider refresh introduces a source model with the alias's id:
    // the transform fails, the host disables it, and the list still resolves.
    harness.addSource(
      sourceModel({
        id: "sonnet",
        providerID: "github-copilot",
        name: "Ahora soy fuente",
        released: 9,
      }),
    );
    await expect(harness.ctx.model.list()).resolves.toBeDefined();
    expect(harness.callbacks).toHaveLength(0);
    expect(harness.view().get("github-copilot/sonnet")?.name).toBe("Ahora soy fuente");
    expect(harness.view().get("github-copilot/sonnet")?.id).toBe("sonnet");
  });

  it("el cleanup devuelto separa el registro y es idempotente", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    const cleanup = await floatingModels.setup(harness.ctx);
    expect(harness.callbacks).toHaveLength(1);
    if (typeof cleanup !== "function") throw new Error("setup did not return a cleanup");
    await cleanup();
    expect(harness.callbacks).toHaveLength(0);
    await cleanup(); // idempotent
    expect(harness.callbacks).toHaveLength(0);
  });

  it("strict con catálogo vacío falla en setup sin candidatos", async () => {
    const harness = createHarness({
      sources: [],
      options: { strict: true, aliases: { "anthropic/void": { match: "anthropic/**" } } },
    });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/strict/);
  });

  it("el orden de declaración no afecta y las repeticiones no encadenan alias", async () => {
    const options = (order: "ab" | "ba") => ({
      aliases:
        order === "ab"
          ? {
              "anthropic/alias-a": { match: "anthropic/**" },
              "anthropic/alias-b": { match: "anthropic/**" },
            }
          : {
              "anthropic/alias-b": { match: "anthropic/**" },
              "anthropic/alias-a": { match: "anthropic/**" },
            },
    });
    const sources = () => [
      sourceModel({ id: "claude-a", providerID: "anthropic", name: "A", released: 1_000 }),
      sourceModel({ id: "claude-b", providerID: "anthropic", name: "B", released: 2_000 }),
    ];

    for (const order of ["ab", "ba"] as const) {
      const harness = createHarness({ sources: sources(), options: options(order) });
      await floatingModels.setup(harness.ctx);
      harness.replay();
      harness.replay(); // second replay: fresh state from the source
      expect(harness.view().get("anthropic/alias-a")?.modelID).toBe("claude-b");
      expect(harness.view().get("anthropic/alias-b")?.modelID).toBe("claude-b");
    }
  });

  it("tolerante: un alias sin resolver avisa y el otro resuelve", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        aliases: {
          "anthropic/good": { match: "anthropic/**" },
          "openai/void": { match: "openai/**" },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    expect(harness.view().get("anthropic/good")?.modelID).toBe("claude-b");
    expect(harness.view().get("openai/void")).toBeUndefined();
    expect(warnings.some((w) => w.includes('"openai/void"'))).toBe(true);
    // The resolved alias does not produce a warning.
    expect(warnings.some((w) => w.includes('"anthropic/good"'))).toBe(false);
  });

  it("camino exitoso silencioso por defecto; debug:true registra diagnóstico [debug] por console.warn", async () => {
    const quiet = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(quiet.ctx);
    quiet.replay();
    expect(warnings).toEqual([]);
    expect(debugs).toEqual([]);

    const loud = createHarness({
      sources: DEFAULT_SOURCES(),
      options: { ...SIMPLE_OPTIONS(), debug: true },
    });
    await floatingModels.setup(loud.ctx);
    loud.replay();
    // Host v2.0.22 swallows console.debug; the [debug] diagnostics go
    // through console.warn, and console.debug must remain unused.
    expect(debugs).toEqual([]);
    expect(warnings).toHaveLength(2); // setup replay + explicit replay
    for (const message of warnings) {
      expect(message).toContain("[opencode-model-aliases] [debug]");
      expect(message).toContain('alias "github-copilot/sonnet"');
      expect(message).toContain("github-copilot/sonnet-4-exec");
      expect(message).toContain("strategy=latest");
      expect(message).toContain("matched=1");
      expect(message).toContain("eligible=1");
      expect(message).toContain("released=3000");
      // Only public model metadata; no credentials or prompts.
      expect(message).not.toMatch(/token|key|secret|password/i);
    }
  });
});

describe("opencode-model-aliases plugin: escape de caracteres de control", () => {
  const CONTROL = /\p{Cc}/u;
  const ESC = "\u001B[31mINJECTED";
  const BEL = "\u0007";
  const DEL = "\u007F";

  /** No C0/C1/DEL control characters and with the escaping visible. */
  function expectEscaped(message: string): void {
    expect(CONTROL.test(message)).toBe(false);
    expect(message).toContain("\\u001b");
    expect(message).toContain("INJECTED");
  }

  it("el aviso tolerante escapa la clave del alias con ESC/BEL/DEL", async () => {
    const hostileKey = `anthropic/esc${ESC}${BEL}${DEL}`;
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: { aliases: { [hostileKey]: { match: "anthropic/nonexistent*" } } },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const hostile = warnings.filter((w) => w.includes("unresolved"));
    expect(hostile).toHaveLength(2); // setup replay + explicit replay
    for (const message of hostile) {
      expectEscaped(message);
      expect(message).toContain('alias "anthropic/esc');
      expect(message).toContain("(no-eligible)");
    }
  });

  it("el aviso de depuración escapa la clave del alias y el modelID del ganador", async () => {
    const hostileKey = `anthropic/alias-${ESC}${BEL}`;
    const harness = createHarness({
      sources: [sourceModel({ id: `wire-${ESC}${BEL}`, providerID: "anthropic", released: 3_000 })],
      options: {
        debug: true,
        aliases: { [hostileKey]: { match: "anthropic/**" } },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const hostile = warnings.filter((w) => w.includes("[debug]"));
    expect(hostile).toHaveLength(2);
    for (const message of hostile) {
      expectEscaped(message);
      expect(message).toContain('alias "anthropic/alias-\\u001b[31mINJECTED\\u0007"');
      expect(message).toContain("/wire-\\u001b[31mINJECTED\\u0007");
      expect(message).toContain("strategy=latest");
    }
  });

  it("el error de colisión escapa la clave del alias", async () => {
    const hostileKey = `anthropic/esc${ESC}`;
    const harness = createHarness({
      sources: [sourceModel({ id: `esc${ESC}`, providerID: "anthropic", released: 1_000 })],
      options: { aliases: { [hostileKey]: { match: "anthropic/**" } } },
    });
    let message = "";
    try {
      await floatingModels.setup(harness.ctx);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("configuration collision");
    expectEscaped(message);
    expect(message).toContain('alias "anthropic/esc\\u001b[31mINJECTED"');
  });

  it("el error de preflight strict escapa la clave del alias", async () => {
    const hostileKey = `anthropic/void${ESC}${DEL}`;
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: {
        strict: true,
        aliases: { [hostileKey]: { match: "anthropic/nonexistent*" } },
      },
    });
    let message = "";
    try {
      await floatingModels.setup(harness.ctx);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("strict: unresolved aliases");
    expectEscaped(message);
    expect(message).toContain("anthropic/void\\u001b[31mINJECTED\\u007f (no-eligible)");
  });

  it("el motivo de fallo de carga del archivo de config escapa la ruta con caracteres de control", async () => {
    const hostileDir = `${tempRoot}/esc${ESC}${BEL}`;
    writeConfigFile(hostileDir, "{ no es jsonc válido");
    const harness = createHarness({ directory: hostileDir, options: {} });
    let message = "";
    try {
      await floatingModels.setup(harness.ctx);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("invalid configuration");
    expectEscaped(message);
    expect(message).toContain("malformed JSONC");
  });

  it("el motivo de fallo de normalización escapa la clave del alias", async () => {
    const hostileKey = `anthropic/esc${ESC}${BEL}`;
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      options: { aliases: { [hostileKey]: {} } },
    });
    let message = "";
    try {
      await floatingModels.setup(harness.ctx);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("invalid configuration");
    expectEscaped(message);
    expect(message).toContain('alias "anthropic/esc\\u001b[31mINJECTED\\u0007"');
    expect(message).toContain("match is required");
  });
});
