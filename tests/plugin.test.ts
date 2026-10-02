import type { Model, Plugin } from "@opencode/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import floatingModels from "../src/index.js";
import { makeTempRoot, removeTempRoot } from "./config-fs.js";

type ModelInfo = Model.Info;

/** Fábrica de Model.Info de prueba; las marcas de effect exigen un único cast. */
function sourceModel(overrides: {
  id: string;
  providerID: string;
  modelID?: string;
  name?: string;
  status?: "active" | "alpha" | "beta" | "deprecated";
  enabled?: boolean;
  released?: number;
  package?: string;
  canonical?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
  capabilities?: { tools: boolean; input: string[]; output: string[] };
  variants?: Array<{ id: string }>;
  cost?: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
  limit?: { context: number; input?: number; output: number };
}): ModelInfo {
  const info = {
    id: overrides.id,
    modelID: overrides.modelID ?? overrides.id,
    providerID: overrides.providerID,
    name: overrides.name ?? overrides.id,
    capabilities: overrides.capabilities ?? { tools: true, input: ["text"], output: ["text"] },
    variants: overrides.variants ?? [],
    time: { released: overrides.released ?? 0 },
    cost: overrides.cost ?? [],
    status: overrides.status ?? "active",
    enabled: overrides.enabled ?? true,
    limit: overrides.limit ?? { context: 200_000, output: 8_192 },
  };
  const extra: Record<string, unknown> = {};
  for (const key of [
    "package",
    "canonical",
    "settings",
    "headers",
    "body",
    "compatibility",
  ] as const) {
    if (overrides[key] !== undefined) extra[key] = overrides[key];
  }
  return { ...info, ...extra } as unknown as ModelInfo;
}

/**
 * Harness fiel al host v2 (State.get):
 * - `replay()` invoca los callbacks en orden y propaga los throws (útil directo).
 * - `model.list()` reconstruye el estado derivado desde el catálogo fuente,
 *   ejecuta los callbacks en orden y, si uno falla, descarta las ediciones
 *   parciales reconstruyendo desde la fuente, separa el registro fallido
 *   (dispose) y resuelve la lista con éxito igualmente.
 * - `dispose()` separa el callback registrado y es idempotente.
 */
function createHarness(input: {
  sources?: ModelInfo[];
  options?: Record<string, unknown>;
  /** Directorio del host para el lookup del archivo de config; nunca el repo real. */
  directory?: string;
}) {
  const source = new Map<string, ModelInfo>();
  for (const model of input.sources ?? []) {
    source.set(`${model.providerID}/${model.id}`, structuredClone(model));
  }
  let working = new Map<string, ModelInfo>();
  const callbacks: Array<(editor: unknown) => void> = [];
  const registrations: Array<{ callback: (editor: unknown) => void; disposed: boolean }> = [];
  let listFailure: unknown;

  const freshFromSource = () => {
    const next = new Map<string, ModelInfo>();
    for (const [key, model] of source) next.set(key, structuredClone(model));
    return next;
  };

  const editor = {
    list: () => [...working.values()],
    get: (providerID: string, modelID: string) => working.get(`${providerID}/${modelID}`),
    update: (providerID: string, modelID: string, update: (model: ModelInfo) => void) => {
      const key = `${providerID}/${modelID}`;
      const current = working.get(key) ?? ({ id: modelID, modelID, providerID } as ModelInfo);
      update(current);
      working.set(key, current);
    },
    remove: (providerID: string, modelID: string) => {
      working.delete(`${providerID}/${modelID}`);
    },
  };

  const replay = () => {
    // Semántica v2: cada repetición parte del catálogo fuente fresco.
    working = freshFromSource();
    for (const callback of [...callbacks]) callback(editor);
  };

  const detach = (callback: (editor: unknown) => void) => {
    const index = callbacks.indexOf(callback);
    if (index >= 0) callbacks.splice(index, 1);
  };

  const ctx = {
    location: { directory: input.directory ?? tempRoot },
    options: input.options ?? {},
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        const entry = { callback, disposed: false };
        registrations.push(entry);
        callbacks.push(callback);
        return {
          dispose: async () => {
            if (entry.disposed) return;
            entry.disposed = true;
            detach(callback);
          },
        };
      },
      list: async () => {
        if (listFailure !== undefined) {
          const error = listFailure;
          listFailure = undefined;
          throw error;
        }
        working = freshFromSource();
        for (const callback of [...callbacks]) {
          try {
            callback(editor);
          } catch {
            // Host v2: el fallo del transform deshabilita el plugin; el estado
            // parcial se descarta reconstruyendo desde la fuente.
            detach(callback);
            working = freshFromSource();
          }
        }
        return editor.list();
      },
    },
  } as unknown as Plugin.Context;
  return {
    ctx,
    /** Estado visible tras la última repetición/lista (derivado). */
    view: () => working,
    /** Catálogo fuente; simula refrescos del proveedor. */
    addSource: (model: ModelInfo) =>
      source.set(`${model.providerID}/${model.id}`, structuredClone(model)),
    removeSource: (providerID: string, id: string) => source.delete(`${providerID}/${id}`),
    callbacks,
    /** Arma un fallo del próximo `ctx.model.list()` (falla del host). */
    failNextList: (error: unknown) => {
      listFailure = error;
    },
    replay,
  };
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
    expect(alias?.name).toBe("Sonnet (floating)");
  });

  it("mantiene id estable, name por defecto y el modelID de ejecución del ganador", async () => {
    const harness = createHarness({ sources: DEFAULT_SOURCES(), options: SIMPLE_OPTIONS() });
    await floatingModels.setup(harness.ctx);
    harness.replay();
    const alias = harness.view().get("github-copilot/sonnet");
    expect(alias?.id).toBe("sonnet");
    expect(alias?.modelID).toBe("sonnet-4-exec");
    expect(alias?.providerID).toBe("github-copilot");
    expect(alias?.name).toBe("Sonnet (floating)");
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
    // La identidad visible no depende del name del ganador.
    expect(harness.view().get("github-copilot/sonnet")?.name).toBe("Sonnet (floating)");
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
    // El estado derivado se reconstruye desde la fuente: sin alias residual.
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
    // El modelo fuente no fue suprimido ni suplantado.
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
    // El transform fue separado pese a que el list() del host resolvió.
    expect(harness.callbacks).toHaveLength(0);
    // El catálogo fuente permanece intacto.
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

    // Un refresco del proveedor introduce un modelo fuente con el id del alias:
    // el transform falla, el host lo deshabilita y la lista resuelve igualmente.
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
    await cleanup(); // idempotente
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
      harness.replay(); // segunda repetición: estado fresco desde la fuente
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
    // El alias resuelto no genera warning.
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
    // El host v2.0.22 traga console.debug; el diagnóstico [debug] va por
    // console.warn, y console.debug debe seguir sin uso.
    expect(debugs).toEqual([]);
    expect(warnings).toHaveLength(2); // repetición del setup + repetición explícita
    for (const message of warnings) {
      expect(message).toContain("[opencode-model-aliases] [debug]");
      expect(message).toContain('alias "github-copilot/sonnet"');
      expect(message).toContain("github-copilot/sonnet-4-exec");
      expect(message).toContain("strategy=latest");
      expect(message).toContain("matched=1");
      expect(message).toContain("eligible=1");
      expect(message).toContain("released=3000");
      // Solo metadatos públicos del modelo; sin credenciales ni prompts.
      expect(message).not.toMatch(/token|key|secret|password/i);
    }
  });
});
