import type { Model } from "@opencode/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import floatingModels, { normalizeOptions } from "../src/index.js";
import { buildRows, sanitize, UNAVAILABLE_REPORT } from "../src/report.js";
import { ModelAliasesRpc } from "../src/rpc.js";
import { makeTempRoot, removeTempRoot } from "./config-fs.js";
import { createHarness, sourceModel } from "./harness.js";

type ModelInfo = Model.Info;

// Contador del resolvedor: el handler del RPC no debe invocar resolveLatest
// por su cuenta; solo los replays del transform lo hacen.
const { resolverCalls } = vi.hoisted(() => ({ resolverCalls: [] as string[] }));
vi.mock("../src/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resolve.js")>();
  return {
    ...actual,
    resolveLatest: (models: unknown, alias: { key: string }) => {
      resolverCalls.push(alias.key);
      return actual.resolveLatest(
        models as Parameters<typeof actual.resolveLatest>[0],
        alias as Parameters<typeof actual.resolveLatest>[1],
      );
    },
  };
});

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

let tempRoot: string;
let warnings: string[];

beforeEach(() => {
  tempRoot = makeTempRoot();
  warnings = [];
  resolverCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoot(tempRoot);
});

describe("ModelAliasesRpc contract", () => {
  it("fija id, método único inspect con esquema JSON vacío, salida {text} y sin eventos", () => {
    expect(ModelAliasesRpc.id).toBe("opencode-model-aliases");
    expect(Object.keys(ModelAliasesRpc.methods)).toEqual(["inspect"]);
    expect(ModelAliasesRpc.methods.inspect.input).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(ModelAliasesRpc.methods.inspect.output).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(ModelAliasesRpc.events).toEqual({});
  });

  it("el setup registra exactamente esa definición tras una inicialización exitosa", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      directory: tempRoot,
      options: { aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } } },
    });
    await floatingModels.setup(harness.ctx);
    expect(harness.rpc.definitions).toHaveLength(1);
    expect(harness.rpc.definitions[0]).toBe(ModelAliasesRpc);
    expect(harness.rpc.handlers[0]?.inspect).toBeTypeOf("function");
  });
});

describe("inspect report", () => {
  const setup = async (options: Record<string, unknown>, sources = DEFAULT_SOURCES()) => {
    const harness = createHarness({ sources, directory: tempRoot, options });
    const cleanup = await floatingModels.setup(harness.ctx);
    return { harness, cleanup };
  };

  it("distingue el id del catálogo del modelID de ejecución (wire) por separado", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain(
      "github-copilot/sonnet → github-copilot/sonnet-4 (active) (wire modelID: sonnet-4-exec)",
    );
    // El objetivo mostrado es el id real del catálogo, no el wire.
    expect(text).not.toContain("→ github-copilot/sonnet-4-exec");
  });

  it("sin wire distinto del id del catálogo no menciona wire modelID", async () => {
    const { harness } = await setup({ aliases: { "anthropic/pick": { match: "anthropic/**" } } });
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("anthropic/pick → anthropic/claude-b (active)");
    expect(text).not.toContain("wire modelID");
  });

  it("las filas tolerantes sin resolver muestran kind y reason", async () => {
    const { harness } = await setup({
      aliases: {
        "anthropic/good": { match: "anthropic/**" },
        "openai/void": { match: "openai/**" },
      },
    });
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("anthropic/good → anthropic/claude-b (active)");
    expect(text).toContain(
      "openai/void → unresolved (no-eligible): no candidate matched match/exclude patterns",
    );
  });

  it("el informe se refresca cuando un objetivo nuevo aparece", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("github-copilot/sonnet-4");
    harness.addSource(
      sourceModel({
        id: "sonnet-5",
        providerID: "github-copilot",
        name: "Sonnet 5",
        released: 9_000,
      }),
    );
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("github-copilot/sonnet → github-copilot/sonnet-5 (active)");
    expect(text).not.toContain("sonnet-4");
  });

  it("cuando el objetivo desaparece, la fila pasa a unresolved con kind/reason", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("(active)");
    harness.removeSource("github-copilot", "sonnet-4");
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("github-copilot/sonnet → unresolved");
    expect(text).not.toContain("(active)");
  });

  it("un alias materializado que una política posterior retira se marca inactive", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    // Otro plugin posterior elimina el alias del catálogo final.
    await harness.ctx.model.transform((editor) => {
      (editor as unknown as { remove: (p: string, m: string) => void }).remove("anthropic", "pick");
    });
    const text = await harness.inspect();
    expect(text).toContain("anthropic/pick → anthropic/claude-b (inactive: not in final catalog)");
    expect(text).not.toContain("(active)");
  });

  it("un transform posterior que deshabilita el alias lo marca inactive, no active", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("(active)");
    // Otro plugin posterior deshabilita el alias materializado.
    await harness.ctx.model.transform((editor) => {
      (
        editor as unknown as {
          update: (p: string, m: string, fn: (model: ModelInfo) => void) => void;
        }
      ).update("anthropic", "pick", (model) => {
        (model as { enabled: boolean }).enabled = false;
      });
    });
    const text = await harness.inspect();
    expect(text).toContain("anthropic/pick → anthropic/claude-b (inactive: not in final catalog)");
    expect(text).not.toContain("(active)");
  });

  it("un transform posterior que cambia el wire del alias ⇒ informe indisponible, no objetivo viejo como activo", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("anthropic/pick → anthropic/claude-b (active)");
    // Otro plugin posterior reescribe el modelID de ejecución del alias.
    await harness.ctx.model.transform((editor) => {
      (
        editor as unknown as {
          update: (p: string, m: string, fn: (model: ModelInfo) => void) => void;
        }
      ).update("anthropic", "pick", (model) => {
        (model as { modelID: string }).modelID = "claude-rewired";
      });
    });
    const text = await harness.inspect();
    expect(text).toBe(UNAVAILABLE_REPORT);
    expect(text).not.toContain("(active)");
    expect(text).not.toContain("anthropic/claude-b");
  });

  it("un transform posterior que reafirma el mismo wire (sin cambio) mantiene el informe activo", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    await harness.ctx.model.transform((editor) => {
      (
        editor as unknown as {
          update: (p: string, m: string, fn: (model: ModelInfo) => void) => void;
        }
      ).update("github-copilot", "sonnet", (model) => {
        (model as { modelID: string }).modelID = "sonnet-4-exec";
      });
    });
    const text = await harness.inspect();
    expect(text).toContain(
      "github-copilot/sonnet → github-copilot/sonnet-4 (active) (wire modelID: sonnet-4-exec)",
    );
  });

  it("configuración vacía: informe sin aliases, sin modelo materializado", async () => {
    const { harness } = await setup({ aliases: {} });
    const text = await harness.inspect();
    expect(text).toBe("No aliases configured.");
    expect(harness.view().size).toBe(DEFAULT_SOURCES().length);
  });

  it("el handler consulta model.list antes de leer el snapshot; refresco fallido ⇒ indisponibilidad", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    const before = harness.counters.list;
    // El refresco falla y el host traga el error: NUNCA se sirve el snapshot
    // previo ni uno parcial.
    harness.failEveryList(new Error("host refresh down"));
    expect(await harness.inspect()).toBe(UNAVAILABLE_REPORT);
    expect(harness.counters.list).toBeGreaterThan(before);
    harness.restoreList();
    expect(await harness.inspect()).toContain("anthropic/pick → anthropic/claude-b (active)");
  });

  it("una repetición fallida limpia el snapshot: nada parcial ni stale como actual", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    // Colisión: el id del alias aparece como modelo fuente; la repetición
    // falla (el transform se limpia y rethrow).
    harness.addSource(
      sourceModel({ id: "pick", providerID: "anthropic", name: "Fuente", released: 9 }),
    );
    expect(() => harness.replay()).toThrow(/configuration collision/);
    // El host traga el fallo y resuelve la lista; el informe debe seguir
    // indisponible, no describir el snapshot viejo.
    const text = await harness.inspect();
    expect(text).toBe(UNAVAILABLE_REPORT);
    // El registro fallido fue separado por el host.
    expect(harness.callbacks).toHaveLength(0);
  });

  it("el handler no llama al resolvedor ni a APIs de proveedor/sesión/generación", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    // Cada replay resuelve una vez por alias; setup (list inicial) y un
    // replay explican las dos primeras. Dos inspecciones añaden solo los
    // replays que el propio model.list() dispara, nunca llamadas extra del
    // handler ni reload/provider/session/generate.
    expect(resolverCalls).toEqual(["anthropic/pick", "anthropic/pick"]);
    await harness.inspect();
    await harness.inspect();
    expect(resolverCalls).toEqual([
      "anthropic/pick",
      "anthropic/pick",
      "anthropic/pick",
      "anthropic/pick",
    ]);
    expect(harness.counters.reload).toBe(0);
    expect(harness.counters.providerList).toBe(0);
    expect(harness.counters.sessionList).toBe(0);
    expect(harness.counters.generateText).toBe(0);
  });

  it("el informe es determinista y está ordenado por clave aunque la declaración difiera", async () => {
    const { harness } = await setup({
      aliases: {
        "anthropic/zz": { match: "anthropic/claude-b" },
        "anthropic/aa": { match: "anthropic/claude-a" },
      },
    });
    harness.replay();
    const text = await harness.inspect();
    const indexZz = text.indexOf("anthropic/zz →");
    const indexAa = text.indexOf("anthropic/aa →");
    expect(indexAa).toBeGreaterThan(0);
    expect(indexAa).toBeLessThan(indexZz);
  });

  it("fallo del registro RPC: el modelo se desecha y el setup rechaza con cero recursos", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      directory: tempRoot,
      options: { aliases: { "anthropic/pick": { match: "anthropic/**" } } },
      rpcRegisterError: new Error("rpc refused"),
    });
    await expect(floatingModels.setup(harness.ctx)).rejects.toThrow(/rpc refused/);
    expect(harness.callbacks).toHaveLength(0);
    expect(harness.rpc.registrations).toHaveLength(0);
  });

  it("unload: el cleanup desecha RPC y transform, y es idempotente", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      directory: tempRoot,
      options: { aliases: { "anthropic/pick": { match: "anthropic/**" } } },
    });
    const cleanup = await floatingModels.setup(harness.ctx);
    expect(harness.callbacks).toHaveLength(1);
    expect(harness.rpc.registrations).toHaveLength(1);
    if (typeof cleanup !== "function") throw new Error("setup did not return a cleanup");
    await cleanup();
    expect(harness.callbacks).toHaveLength(0);
    expect(harness.rpc.registrations[0]?.disposed).toBe(true);
    await cleanup();
    expect(harness.callbacks).toHaveLength(0);
  });
});

describe("report primitives", () => {
  it("las filas solo contienen primitivas públicas permitidas", () => {
    const rich = sourceModel({
      id: "sonnet-4",
      providerID: "github-copilot",
      released: 3_000,
      settings: { compaction: { type: "summary" } },
      headers: { "x-hint": "cache" },
      body: { temperature: 0.7 },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    });
    const normalized = normalizeOptions({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    if (!normalized.ok) throw new Error("options should normalize");
    const alias = normalized.config.aliases[0];
    if (!alias) throw new Error("alias should exist");
    const rows = buildRows([{ alias, result: { ok: true, model: rich, stages: [] } }]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["catalogID", "key", "providerID", "status", "strategy"].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/compaction|temperature|"x-hint"/);
  });

  it("sanitize escapa caracteres de control (ESC/CSI incluidos) en ids y reasons", () => {
    const escaped = sanitize("\u001b[31mred\u0007");
    expect(escaped).toBe("\\u001b[31mred\\u0007");
    expect(sanitize("normal id/with: chars")).toBe("normal id/with: chars");
  });
});
