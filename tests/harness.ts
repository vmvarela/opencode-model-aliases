import type { Model, Plugin } from "@opencode/plugin";

export type ModelInfo = Model.Info;

/** Fábrica de Model.Info de prueba; las marcas de effect exigen un único cast. */
export function sourceModel(overrides: {
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

export type RpcHandlerMap = Record<string, (input: unknown, context: unknown) => Promise<unknown>>;

export interface RpcSpy {
  /** Definiciones registradas (en orden). */
  definitions: unknown[];
  /** Mapas de handlers registrados, alineados con `definitions`. */
  handlers: RpcHandlerMap[];
  /** Altas de registro, con marca de dispose (una por registro). */
  registrations: Array<{ disposed: boolean }>;
}

export interface Counters {
  list: number;
  reload: number;
  providerList: number;
  sessionList: number;
  generateText: number;
}

/**
 * Harness fiel al host v2 (State.get) compartido por los tests backend:
 * - `replay()` invoca los callbacks en orden y propaga los throws (útil directo).
 * - `model.list()` reconstruye el estado derivado desde el catálogo fuente,
 *   ejecuta los callbacks en orden y, si uno falla, descarta las ediciones
 *   parciales reconstruyendo desde la fuente, separa el registro fallido
 *   (dispose) y resuelve la lista con éxito igualmente. Devuelve el sobre
 *   real del host v2: `{ location, data }`.
 * - `dispose()` separa el callback registrado y es idempotente (modelo y RPC).
 * - `inspect()` invoca el handler `inspect` del último RPC registrado.
 * - Fallos de list: `failNextList` (un tiro) y `failEveryList` (hasta
 *   `restoreList`), para simular refrescos fallidos del host.
 */
export function createHarness(input: {
  sources?: ModelInfo[];
  options?: Record<string, unknown>;
  /** Directorio del host para el lookup del archivo de config; nunca el repo real. */
  directory?: string;
  /** Si se define, ctx.rpc.register rechaza con este error. */
  rpcRegisterError?: unknown;
}) {
  const source = new Map<string, ModelInfo>();
  for (const model of input.sources ?? []) {
    source.set(`${model.providerID}/${model.id}`, structuredClone(model));
  }
  let working = new Map<string, ModelInfo>();
  const callbacks: Array<(editor: unknown) => void> = [];
  const registrations: Array<{ callback: (editor: unknown) => void; disposed: boolean }> = [];
  let listFailure: unknown;
  let stickyListFailure: unknown;

  const rpc: RpcSpy = { definitions: [], handlers: [], registrations: [] };
  const counters: Counters = {
    list: 0,
    reload: 0,
    providerList: 0,
    sessionList: 0,
    generateText: 0,
  };

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
    location: { directory: input.directory },
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
        counters.list += 1;
        if (listFailure !== undefined) {
          const error = listFailure;
          listFailure = undefined;
          throw error;
        }
        if (stickyListFailure !== undefined) throw stickyListFailure;
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
        return {
          location: { directory: input.directory },
          data: editor.list(),
        };
      },
      reload: async () => {
        counters.reload += 1;
      },
    },
    provider: {
      list: async () => {
        counters.providerList += 1;
        return [];
      },
    },
    session: {
      list: async () => {
        counters.sessionList += 1;
        return [];
      },
    },
    generate: {
      text: async () => {
        counters.generateText += 1;
        return { text: "" };
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: RpcHandlerMap) => {
        if (input.rpcRegisterError !== undefined) throw input.rpcRegisterError;
        rpc.definitions.push(definition);
        rpc.handlers.push(handlers);
        const entry = { disposed: false };
        rpc.registrations.push(entry);
        return {
          events: { emit: async () => {} },
          dispose: async () => {
            if (entry.disposed) return;
            entry.disposed = true;
          },
        };
      },
    },
  } as unknown as Plugin.Context;

  const inspect = async (): Promise<string> => {
    const handlers = rpc.handlers.at(-1);
    if (!handlers || typeof handlers.inspect !== "function") {
      throw new Error("no inspect RPC has been registered");
    }
    const result = (await handlers.inspect({}, {})) as { text: string };
    return result.text;
  };

  return {
    ctx,
    /** Estado visible tras la última repetición/lista (derivado). */
    view: () => working,
    callbacks,
    /** Catálogo fuente; simula refrescos del proveedor. */
    addSource: (model: ModelInfo) =>
      source.set(`${model.providerID}/${model.id}`, structuredClone(model)),
    removeSource: (providerID: string, id: string) => source.delete(`${providerID}/${id}`),
    replay,
    /** Un tiro: el siguiente list() falla. */
    failNextList: (error: unknown) => {
      listFailure = error;
    },
    /** Persistente: todo list() falla hasta `restoreList()`. */
    failEveryList: (error: unknown) => {
      stickyListFailure = error;
    },
    restoreList: () => {
      stickyListFailure = undefined;
    },
    rpc,
    counters,
    inspect,
  };
}
