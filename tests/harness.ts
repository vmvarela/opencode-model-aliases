import type { Model, Plugin } from "@opencode/plugin";

export type ModelInfo = Model.Info;

/** Test Model.Info factory; the effect marks require a single cast. */
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
  /** Registered definitions (in order). */
  definitions: unknown[];
  /** Registered handler maps, aligned with `definitions`. */
  handlers: RpcHandlerMap[];
  /** Registration entries, with dispose flag (one per registration). */
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
 * Harness faithful to the v2 host (State.get) shared by the backend tests:
 * - `replay()` invokes the callbacks in order and propagates throws
 *   (directly useful).
 * - `model.list()` rebuilds the derived state from the source catalog,
 *   runs the callbacks in order and, if one fails, discards the partial
 *   edits by rebuilding from the source, detaches the failed registration
 *   (dispose) and still resolves the list successfully. Returns the real
 *   v2 host envelope: `{ location, data }`.
 * - `dispose()` detaches the registered callback and is idempotent
 *   (model and RPC).
 * - `inspect()` invokes the `inspect` handler of the last registered RPC.
 * - List failures: `failNextList` (one shot) and `failEveryList` (until
 *   `restoreList`), to simulate failed host refreshes.
 */
export function createHarness(input: {
  sources?: ModelInfo[];
  options?: Record<string, unknown>;
  /** Host directory for the config file lookup; never the real repo. */
  directory?: string;
  /** If set, ctx.rpc.register rejects with this error. */
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
    // v2 semantics: each replay starts from the fresh source catalog.
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
            // Host v2: a transform failure disables the plugin; the partial
            // state is discarded by rebuilding from the source.
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
    /** Visible state after the last replay/list (derived). */
    view: () => working,
    callbacks,
    /** Source catalog; simulates provider refreshes. */
    addSource: (model: ModelInfo) =>
      source.set(`${model.providerID}/${model.id}`, structuredClone(model)),
    removeSource: (providerID: string, id: string) => source.delete(`${providerID}/${id}`),
    replay,
    /** One-shot: the next list() fails. */
    failNextList: (error: unknown) => {
      listFailure = error;
    },
    /** Sticky: every list() fails until `restoreList()`. */
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
