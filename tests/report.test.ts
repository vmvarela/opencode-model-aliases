import type { Model } from "@opencode/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import floatingModels, { normalizeOptions } from "../src/index.js";
import {
  type AliasReportRow,
  buildInspectRows,
  buildRows,
  formatReport,
  type InspectReportRow,
  sanitize,
  UNAVAILABLE_REPORT,
} from "../src/report.js";
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
  it("fija id, método único inspect con esquema JSON vacío, salida {text, rows} y sin eventos", () => {
    expect(ModelAliasesRpc.id).toBe("opencode-model-aliases");
    expect(Object.keys(ModelAliasesRpc.methods)).toEqual(["inspect"]);
    expect(ModelAliasesRpc.methods.inspect.input).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(ModelAliasesRpc.methods.inspect.output).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              provider: { type: "string" },
              alias: { type: "string" },
              strategy: { type: "string", enum: ["latest"] },
              status: { type: "string", enum: ["active", "inactive", "unresolved"] },
              target: { type: "string" },
              catalogID: { type: "string" },
              providerID: { type: "string" },
              wireModelID: { type: "string" },
              failureKind: { type: "string" },
              failureReason: { type: "string" },
            },
            required: ["key", "provider", "alias", "strategy", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["text", "rows"],
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
    expect(text).toContain("sonnet\n    → sonnet-4 (wire model ID: sonnet-4-exec)");
    // El objetivo mostrado es el id real del catálogo, no el wire.
    expect(text).not.toContain("→ sonnet-4-exec");
  });

  it("sin wire distinto del id del catálogo no menciona wire modelID", async () => {
    const { harness } = await setup({ aliases: { "anthropic/pick": { match: "anthropic/**" } } });
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("pick\n    → claude-b");
    expect(text).not.toContain("wire model ID");
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
    expect(text).toContain("good\n    → claude-b");
    expect(text).toContain(
      "void\n    → unresolved (no-eligible): no candidate matched match/exclude patterns",
    );
  });

  it("el informe se refresca cuando un objetivo nuevo aparece", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("sonnet-4");
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
    expect(text).toContain("sonnet\n    → sonnet-5");
    expect(text).not.toContain("sonnet-4");
  });

  it("cuando el objetivo desaparece, la fila pasa a unresolved con kind/reason", async () => {
    const { harness } = await setup({
      aliases: { "github-copilot/sonnet": { match: "github-copilot/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("1 active");
    harness.removeSource("github-copilot", "sonnet-4");
    harness.replay();
    const text = await harness.inspect();
    expect(text).toContain("sonnet\n    → unresolved");
    expect(text).not.toContain("1 active");
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
    expect(text).toContain("pick\n    → claude-b (inactive: not in final catalog)");
    expect(text).not.toContain("1 active");
  });

  it("un transform posterior que deshabilita el alias lo marca inactive, no active", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("1 active");
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
    expect(text).toContain("pick\n    → claude-b (inactive: not in final catalog)");
    expect(text).not.toContain("1 active");
  });

  it("un transform posterior que cambia el wire del alias ⇒ informe indisponible, no objetivo viejo como activo", async () => {
    const { harness } = await setup({
      aliases: { "anthropic/pick": { match: "anthropic/**" } },
    });
    harness.replay();
    expect(await harness.inspect()).toContain("pick\n    → claude-b");
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
    expect(text).not.toContain("1 active");
    expect(text).not.toContain("claude-b");
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
    expect(text).toContain("sonnet\n    → sonnet-4 (wire model ID: sonnet-4-exec)");
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
    expect(await harness.inspect()).toContain("pick\n    → claude-b");
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
    const indexZz = text.indexOf("  zz\n");
    const indexAa = text.indexOf("  aa\n");
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

describe("formatReport visual and structural layout", () => {
  it("muestra informe vacío cuando no hay aliases", () => {
    expect(formatReport([], new Set())).toBe("No aliases configured.");
  });

  it("formatea 8 aliases reales incluyendo gpt-terra sin prefijos redundantes ni etiquetas repetitivas", () => {
    const actual8: AliasReportRow[] = [
      {
        key: "github-copilot/gemini-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "github-copilot",
        catalogID: "gemini-2.5-flash",
      },
      {
        key: "github-copilot/sonnet",
        strategy: "latest",
        status: "resolved",
        providerID: "github-copilot",
        catalogID: "claude-3-5-sonnet-20241022",
      },
      {
        key: "openai/gpt-luna",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "gpt-4o-mini-2024-07-18",
      },
      {
        key: "openai/gpt-sol",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "o1-preview",
      },
      {
        key: "openai/gpt-terra",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "gpt-4o-2024-11-20",
      },
      {
        key: "opencode-go/deepseek-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "deepseek-v3-flash",
      },
      {
        key: "opencode-go/glm-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "glm-4-flash",
      },
      {
        key: "opencode-go/qwen-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "qwen-2.5-coder-32b-flash",
      },
    ];

    const visibleKeys = new Set(actual8.map((r) => r.key));
    const output = formatReport(actual8, visibleKeys);

    // Encabezado y resumen compacto.
    expect(output).toContain("Model aliases (strategy: latest)\n8 aliases · 8 active");

    // Secciones agrupadas por proveedor.
    expect(output).toContain(
      "github-copilot\n  gemini-flash\n    → gemini-2.5-flash\n  sonnet\n    → claude-3-5-sonnet-20241022",
    );
    expect(output).toContain(
      "openai\n  gpt-luna\n    → gpt-4o-mini-2024-07-18\n  gpt-sol\n    → o1-preview\n  gpt-terra\n    → gpt-4o-2024-11-20",
    );
    expect(output).toContain(
      "opencode-go\n  deepseek-flash\n    → deepseek-v3-flash\n  glm-flash\n    → glm-4-flash\n  qwen-flash\n    → qwen-2.5-coder-32b-flash",
    );

    // Sin repetición de prefijos de proveedor en las líneas de alias ni en los destinos.
    expect(output).not.toContain("github-copilot/gemini-flash");
    expect(output).not.toContain("→ github-copilot/");
    expect(output).not.toContain("openai/gpt-terra");
    expect(output).not.toContain("→ openai/");

    // Sin repetición de etiqueta (active) en cada línea resuelta.
    expect(output).not.toContain("(active)");

    // Ninguna línea supera 50 caracteres (garantía de no desbordamiento en alerta de 550px).
    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(55);
    }
  });

  it("destaca incidencias: inactivos y sin resolver en resumen y filas", () => {
    const rows: AliasReportRow[] = [
      {
        key: "anthropic/active-one",
        strategy: "latest",
        status: "resolved",
        providerID: "anthropic",
        catalogID: "claude-3-5-haiku",
      },
      {
        key: "anthropic/inactive-one",
        strategy: "latest",
        status: "resolved",
        providerID: "anthropic",
        catalogID: "claude-old",
      },
      {
        key: "openai/missing",
        strategy: "latest",
        status: "unresolved",
        failureKind: "no-eligible",
        failureReason: "no candidate matched pattern",
      },
    ];

    // Solo active-one está en el catálogo final.
    const visible = new Set(["anthropic/active-one"]);
    const output = formatReport(rows, visible);

    // Resumen con desglose explícito de problemas.
    expect(output).toContain("3 aliases · 1 active · 1 inactive · 1 unresolved");

    // Inactivo destacado con etiqueta específica.
    expect(output).toContain("inactive-one\n    → claude-old (inactive: not in final catalog)");

    // Sin resolver destacado con kind y reason.
    expect(output).toContain(
      "missing\n    → unresolved (no-eligible): no candidate matched pattern",
    );
  });

  it("muestra el wire model ID de ejecución de forma nítida cuando difiere", () => {
    const rows: AliasReportRow[] = [
      {
        key: "github-copilot/sonnet",
        strategy: "latest",
        status: "resolved",
        providerID: "github-copilot",
        catalogID: "sonnet-4",
        wireModelID: "sonnet-4-exec",
      },
    ];
    const output = formatReport(rows, new Set(["github-copilot/sonnet"]));
    expect(output).toContain("sonnet\n    → sonnet-4 (wire model ID: sonnet-4-exec)");
  });

  it("maneja singular correctamente en el resumen", () => {
    const rows: AliasReportRow[] = [
      {
        key: "anthropic/solo",
        strategy: "latest",
        status: "resolved",
        providerID: "anthropic",
        catalogID: "claude-3-5-sonnet",
      },
    ];
    const output = formatReport(rows, new Set(["anthropic/solo"]));
    expect(output).toContain("1 alias · 1 active");
  });
});

describe("buildInspectRows structured public primitives", () => {
  it("construye filas estructuradas para los 8 aliases incluyendo gpt-terra", () => {
    const actual8: AliasReportRow[] = [
      {
        key: "github-copilot/gemini-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "github-copilot",
        catalogID: "gemini-2.5-flash",
      },
      {
        key: "github-copilot/sonnet",
        strategy: "latest",
        status: "resolved",
        providerID: "github-copilot",
        catalogID: "claude-3-5-sonnet-20241022",
        wireModelID: "sonnet-4-exec",
      },
      {
        key: "openai/gpt-luna",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "gpt-4o-mini-2024-07-18",
      },
      {
        key: "openai/gpt-sol",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "o1-preview",
      },
      {
        key: "openai/gpt-terra",
        strategy: "latest",
        status: "resolved",
        providerID: "openai",
        catalogID: "gpt-4o-2024-11-20",
      },
      {
        key: "opencode-go/deepseek-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "deepseek-v3-flash",
      },
      {
        key: "opencode-go/glm-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "glm-4-flash",
      },
      {
        key: "opencode-go/qwen-flash",
        strategy: "latest",
        status: "resolved",
        providerID: "opencode-go",
        catalogID: "qwen-2.5-coder-32b-flash",
      },
    ];

    const visibleKeys = new Set(actual8.map((r) => r.key));
    const inspectRows = buildInspectRows(actual8, visibleKeys);

    expect(inspectRows).toHaveLength(8);

    // Verificación de terra
    const terra = inspectRows.find((r) => r.key === "openai/gpt-terra");
    expect(terra).toEqual({
      key: "openai/gpt-terra",
      provider: "openai",
      alias: "gpt-terra",
      strategy: "latest",
      status: "active",
      target: "gpt-4o-2024-11-20",
      catalogID: "gpt-4o-2024-11-20",
      providerID: "openai",
    });

    // Verificación de sonnet con wire model ID
    const sonnet = inspectRows.find((r) => r.key === "github-copilot/sonnet");
    expect(sonnet?.wireModelID).toBe("sonnet-4-exec");

    // Ninguna fila contiene objetos no serializables ni credenciales
    for (const r of inspectRows) {
      expect(typeof r.key).toBe("string");
      expect(typeof r.provider).toBe("string");
      expect(typeof r.alias).toBe("string");
      expect(r.strategy).toBe("latest");
      expect(r.status).toBe("active");
    }
  });

  it("clasifica estado inactive cuando el alias falta en el catálogo final", () => {
    const rows: AliasReportRow[] = [
      {
        key: "anthropic/pick",
        strategy: "latest",
        status: "resolved",
        providerID: "anthropic",
        catalogID: "claude-b",
      },
    ];
    // visible no contiene anthropic/pick
    const inspectRows = buildInspectRows(rows, new Set());
    expect(inspectRows[0]?.status).toBe("inactive");
  });

  it("conserva kind y reason en filas sin resolver", () => {
    const rows: AliasReportRow[] = [
      {
        key: "openai/void",
        strategy: "latest",
        status: "unresolved",
        failureKind: "no-eligible",
        failureReason: "no match found",
      },
    ];
    const inspectRows = buildInspectRows(rows, new Set());
    expect(inspectRows[0]?.status).toBe("unresolved");
    expect(inspectRows[0]?.failureKind).toBe("no-eligible");
    expect(inspectRows[0]?.failureReason).toBe("no match found");
  });

  it("el handler RPC expone tanto text como rows estructurados en el contrato público", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      directory: tempRoot,
      options: {
        aliases: {
          "github-copilot/sonnet": { match: "github-copilot/**" },
          "anthropic/pick": { match: "anthropic/**" },
        },
      },
    });
    await floatingModels.setup(harness.ctx);
    harness.replay();

    const handler = harness.rpc.handlers[0]?.inspect;
    if (!handler) throw new Error("inspect handler missing");

    const result = (await handler({}, {})) as {
      text: string;
      rows: InspectReportRow[];
    };
    expect(typeof result.text).toBe("string");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows).toHaveLength(2);

    expect(result.rows[0]?.key).toBe("anthropic/pick");
    expect(result.rows[0]?.status).toBe("active");

    expect(result.rows[1]?.key).toBe("github-copilot/sonnet");
    expect(result.rows[1]?.wireModelID).toBe("sonnet-4-exec");
  });

  it("el handler RPC devuelve rows vacío cuando no hay aliases o cuando el informe está indisponible", async () => {
    const harness = createHarness({
      sources: DEFAULT_SOURCES(),
      directory: tempRoot,
      options: { aliases: {} },
    });
    await floatingModels.setup(harness.ctx);

    const handler = harness.rpc.handlers[0]?.inspect;
    if (!handler) throw new Error("inspect handler missing");

    const emptyResult = (await handler({}, {})) as {
      text: string;
      rows: InspectReportRow[];
    };
    expect(emptyResult.text).toBe("No aliases configured.");
    expect(emptyResult.rows).toEqual([]);

    // Simular fallo de refresco
    harness.failEveryList(new Error("network down"));
    const unavailResult = (await handler({}, {})) as {
      text: string;
      rows: InspectReportRow[];
    };
    expect(unavailResult.text).toBe(UNAVAILABLE_REPORT);
    expect(unavailResult.rows).toEqual([]);
  });
});
