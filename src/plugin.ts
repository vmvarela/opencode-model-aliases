import { type Model, Plugin } from "@opencode/plugin";
import { isPlainObject, type NormalizedConfig, type Options } from "./config.js";
import { loadConfigFile } from "./config-file.js";
import type { ExplainResponse, ResolutionExplanation } from "./explain.js";
import { createHistory } from "./history.js";
import { aliasDisplayName } from "./names.js";
import { normalizeOptions } from "./normalize.js";
import {
  type AliasReportRow,
  buildInspectRows,
  buildRows,
  formatReport,
  sanitize,
  UNAVAILABLE_REPORT,
} from "./report.js";
import { resolveLatest } from "./resolve.js";
import { ModelAliasesRpc } from "./rpc.js";

const PLUGIN_ID = "opencode-model-aliases";
const LOG_PREFIX = `[${PLUGIN_ID}]`;

type ModelInfo = Model.Info;

/**
 * Minimal editor the adapter needs from the v2 transform. The real host
 * declaration wraps fields in DeepMutable and degrades strings with brand;
 * the registration boundary converts the host editor to this view.
 */
interface FloatingEditor {
  list(): readonly ModelInfo[];
  update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void;
  remove(providerID: string, modelID: string): void;
}

/**
 * One transform replay. Per v2 semantics, each replay starts from the fresh
 * source catalog (no output from previous replays): snapshot once, collision
 * checked against that snapshot, single resolution per alias, and
 * materialization. No alias feeds another.
 *
 * The strict preflight only applies while `preflight` is true (during setup's
 * initial read); afterwards, losing every candidate degrades the alias to the
 * tolerant path instead of tearing down the whole registration (#55).
 *
 * Returns report rows built from the SAME resolution results used to
 * materialize; the caller only publishes them if the whole replay (including
 * materialization) succeeded.
 */
interface ReplayReport {
  rows: readonly AliasReportRow[];
  explanations: ReadonlyMap<string, ResolutionExplanation>;
}

function replay(
  config: NormalizedConfig,
  editor: FloatingEditor,
  preflight: boolean,
): ReplayReport {
  const snapshot = editor.list();

  // Configuration collision: the alias id already exists as a source model.
  // Always fatal, regardless of `strict` or whether the alias resolves.
  for (const alias of config.aliases) {
    const preexisting = snapshot.some(
      (model) => model.providerID === alias.provider && model.id === alias.modelID,
    );
    if (preexisting) {
      throw new Error(
        `${LOG_PREFIX} configuration collision: alias "${sanitize(alias.key)}" would overwrite existing model "${sanitize(alias.provider)}/${sanitize(alias.modelID)}"`,
      );
    }
  }

  // One resolution per alias; the same decision serves the strict preflight
  // and materialization. One clock reading per replay: every alias in the
  // same replay ages uniformly even if resolution is slow.
  const now = Date.now();
  const results = config.aliases.map((alias) => ({
    alias,
    result: resolveLatest(snapshot, alias, now),
  }));

  if (preflight && config.strict) {
    const parts: string[] = [];
    for (const { alias, result } of results) {
      if (!result.ok) parts.push(`${sanitize(alias.key)} (${sanitize(result.failure.kind)})`);
    }
    if (parts.length > 0) {
      throw new Error(
        `${LOG_PREFIX} strict: unresolved aliases before materialization: ${parts.join(", ")}`,
      );
    }
  }

  for (const { alias, result } of results) {
    if (!result.ok) {
      // Tolerant: warn and skip only this alias; the rest continue.
      console.warn(
        `${LOG_PREFIX} alias "${sanitize(alias.key)}" unresolved (${sanitize(result.failure.kind)}): ${sanitize(result.failure.reason)}`,
      );
      continue;
    }
    const { model: winner, stages } = result;
    const label = aliasDisplayName(alias);
    editor.update(alias.provider, alias.modelID, (model) => {
      const clone = structuredClone(winner);
      // Only id and name change; the rest of the winner Model.Info is inherited.
      const patchable = clone as { id: string; name: string };
      patchable.id = alias.modelID;
      patchable.name = label;
      Object.assign(model, clone);
    });
    if (config.debug) {
      const [matching, filtering] = stages;
      // The v2.0.22 host swallows console.debug/console.log from plugins, so
      // debug diagnosis goes through console.warn with the [debug] prefix:
      // messages only contain public model metadata (id, counts, timestamp),
      // never options/headers/credentials or prompts.
      console.warn(
        `${LOG_PREFIX} [debug] alias "${sanitize(alias.key)}" -> ${sanitize(alias.provider)}/${sanitize(winner.modelID)}` +
          ` (strategy=latest, matched=${matching?.accepted ?? 0}, eligible=${filtering?.accepted ?? 0},` +
          ` released=${winner.time.released})`,
      );
    }
  }

  return {
    rows: buildRows(results),
    explanations: new Map(results.map(({ alias, result }) => [alias.key, result.explanation])),
  };
}

type ReloadStatus = "reloaded" | "rejected";

/**
 * A candidate config waiting for the next host rebuild. The transform
 * trials it against a fresh snapshot and settles the waiting reload.
 */
interface StagedReload {
  config: NormalizedConfig;
  settle: (status: ReloadStatus) => void;
}

/**
 * In-memory clone of a catalog snapshot used to trial a staged candidate:
 * the candidate either validates completely on the clone or the real
 * editor is never touched (no partial mutation of the active state).
 */
function shadowEditor(snapshot: readonly ModelInfo[]): FloatingEditor {
  const models = snapshot.map((model) => structuredClone(model));
  return {
    list: () => models,
    update: (providerID, modelID, update) => {
      let model = models.find((entry) => entry.providerID === providerID && entry.id === modelID);
      if (!model) {
        model = { id: modelID, providerID } as ModelInfo;
        models.push(model);
      }
      update(model);
    },
    remove: (providerID, modelID) => {
      const index = models.findIndex(
        (entry) => entry.providerID === providerID && entry.id === modelID,
      );
      if (index >= 0) models.splice(index, 1);
    },
  };
}

/**
 * Startup and reload share one pipeline: nearest config-file discovery,
 * merge with the host inline options (inline wins per key) and full
 * normalization. Returns a sanitized public reason; never throws.
 */
async function loadEffectiveConfig(
  directory: string,
  inline: unknown,
): Promise<{ ok: true; config: NormalizedConfig } | { ok: false; reason: string }> {
  const loaded = await loadConfigFile(directory);
  if (!loaded.ok) return { ok: false, reason: sanitize(loaded.reason) };
  const fileOptions = loaded.file?.options;

  // Untrusted input; merged with the file as base and the inline host
  // values with priority. Full validation happens in normalizeOptions
  // over the merged result.
  if (inline !== undefined && inline !== null && !isPlainObject(inline)) {
    return { ok: false, reason: "options must be an object" };
  }
  const inlineOptions = isPlainObject(inline) ? inline : {};

  // Raw properties of both sources are preserved, including unknown
  // roots: whitelisting would hide typos (e.g. "strcit") before
  // validation. The spread copies as an own data property, safe against
  // hostile "__proto__" keys (never Object.assign on untrusted input).
  // The inline>file order is corrected below for strict/debug.
  const merged: Record<string, unknown> = {
    ...fileOptions,
    ...inlineOptions,
  };
  for (const key of ["strict", "debug"] as const) {
    // The inline value, when supplied (even `false`), wins over the file.
    if (inlineOptions[key] !== undefined) {
      merged[key] = inlineOptions[key];
    } else if (fileOptions?.[key] !== undefined) {
      merged[key] = fileOptions[key];
    }
  }

  // Union by key: an inline entry replaces the whole file AliasConfig
  // for that key (no partial merge). The containers of each source are
  // already validated; an invalid inline container fails here instead of
  // silently extending the map.
  const inlineAliases = inlineOptions.aliases;
  if (inlineAliases !== undefined && !isPlainObject(inlineAliases)) {
    return { ok: false, reason: "aliases must be an object ({} is a valid no-op)" };
  }
  if (fileOptions?.aliases !== undefined || inlineAliases !== undefined) {
    merged.aliases = {
      ...fileOptions?.aliases,
      ...(isPlainObject(inlineAliases) ? inlineAliases : {}),
    };
  }

  const normalized = normalizeOptions(merged as unknown as Options);
  if (!normalized.ok) return { ok: false, reason: sanitize(normalized.failure.reason) };
  return { ok: true, config: normalized.config };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    // Load the effective configuration BEFORE registering any transform:
    // a read/parse/merge/normalize failure leaves zero transforms
    // registered.
    const loaded = await loadEffectiveConfig(ctx.location.directory, ctx.options);
    if (!loaded.ok) {
      throw new Error(`${LOG_PREFIX} invalid configuration: ${loaded.reason}`);
    }
    let config: NormalizedConfig = loaded.config;

    const history = await createHistory(ctx.storage, ctx.location, config.aliases);

    // The v2 host swallows transform exceptions (State.get catches, disables
    // the plugin and rebuilds the state), so the first ctx.model.list() may
    // resolve successfully after a failure. We capture the first error only
    // during the forced initial read and rethrow it: the rethrow keeps the
    // group rollback and, if the host swallowed it, setup fails explicitly.
    let initializing = true;
    let hasInitialError = false;
    let initialError: unknown;

    // Report snapshot of the setup (small closure, primitives only):
    // null means unavailability — the last replay failed and there is no
    // describable current mapping. It is replaced once per replay, only if
    // the whole replay/materialization succeeded; on any failure it is
    // cleared so partial or stale mappings are never described as current.
    let report: ReplayReport | null = null;

    // Candidate config staged by an explicit reload; the next transform
    // invocation trials it and either adopts it or reverts atomically.
    let staged: StagedReload | null = null;

    const registration = await ctx.model.transform((hostEditor) => {
      // Single host→adapter boundary: the host DeepMutable degrades strings
      // with brand; here it is adapted to the clean editor view.
      const editor = hostEditor as unknown as FloatingEditor;
      if (staged) {
        const current = staged;
        staged = null;
        try {
          // Trial on a clone with the same validation as startup
          // (collision + strict preflight): a rejected candidate never
          // touches the real catalog, so the last valid config stays
          // active without partial mutation.
          replay(current.config, shadowEditor(editor.list()), true);
        } catch {
          current.settle("rejected");
          try {
            report = replay(config, editor, false);
          } catch (error) {
            report = null;
            throw error;
          }
          return;
        }
        try {
          report = replay(current.config, editor, false);
        } catch {
          current.settle("rejected");
          // In-callback rollback: throwing would make the host discard the
          // draft AND disable the whole plugin group (and unregister the
          // RPCs). The trial already proved the candidate ids were absent
          // from the original draft, so dropping every candidate entry —
          // including ids shared with the old config, which replay
          // collision-checks against its initial snapshot — leaves a clean
          // source catalog to re-materialize the prior config from.
          for (const alias of current.config.aliases) {
            editor.remove(alias.provider, alias.modelID);
          }
          try {
            report = replay(config, editor, false);
          } catch (error) {
            // Unrecoverable host/editor failure: outside practical
            // recovery, fall back to the detach path with a null report.
            report = null;
            throw error;
          }
          return;
        }
        // Committed only after the candidate fully materialized: the
        // status on the RPC can never disagree with the live catalog.
        config = current.config;
        current.settle("reloaded");
        return;
      }
      try {
        // `initializing` is read live: the initial list() runs the transform
        // while it is still true, capturing errors for setup's preflight.
        report = replay(config, editor, initializing);
      } catch (error) {
        report = null;
        if (initializing && !hasInitialError) {
          hasInitialError = true;
          initialError = error;
        }
        throw error;
      }
    });

    type FinalCatalog = ReadonlyArray<{
      providerID: string;
      id: string;
      modelID?: string;
      enabled?: boolean;
    }>;
    let initialCatalog: FinalCatalog;
    try {
      initialCatalog = (await ctx.model.list()).data;
    } catch (error) {
      initializing = false;
      await registration.dispose();
      throw error;
    }
    if (hasInitialError) {
      initializing = false;
      await registration.dispose();
      throw initialError;
    }
    initializing = false;

    // Serialize confirmation/storage outside the synchronous transform. A later
    // transform can disable or rewrite aliases; only the final catalog counts.
    const readInspection = async (confirmed?: FinalCatalog) => {
      // Minimal view of the final catalog; identity primitives only
      // (provider, id, execution modelID and enabled). No full
      // Model.Info objects, settings, headers or credentials.
      let catalog: FinalCatalog;
      try {
        catalog = confirmed ?? (await ctx.model.list()).data;
      } catch {
        // The refresh failed: neither the previous snapshot nor a partial
        // one; unavailability text and empty rows.
        return { text: UNAVAILABLE_REPORT, rows: [] };
      }
      const current = report;
      if (current === null) {
        return { text: UNAVAILABLE_REPORT, rows: [] };
      }
      const snapshot = current.rows;
      // Final visibility by primitives: an alias disabled by a later
      // policy is not labeled active; a retired alias keeps the existing
      // behavior (inactive).
      const wire = new Map<string, string | undefined>();
      const visible = new Set<string>();
      for (const model of catalog) {
        const entry = `${model.providerID}/${model.id}`;
        wire.set(entry, model.modelID);
        if (model.enabled !== false) visible.add(entry);
      }
      // Identity guard: if the alias is still enabled but a later policy
      // rewrote its execution modelID away from the selected one, the
      // snapshot no longer describes the real mapping. Instead of guessing
      // or showing the old target as active, the whole report becomes
      // unavailable (rare conflicting-policy case).
      for (const row of snapshot) {
        if (row.status !== "resolved" || !visible.has(row.key)) continue;
        const selected = row.wireModelID ?? row.catalogID;
        if (wire.get(row.key) !== selected) {
          return { text: UNAVAILABLE_REPORT, rows: [] };
        }
      }
      const rows = await history.observe(snapshot, visible);
      // Storage is asynchronous: a host replay may supersede this decision while
      // history is being saved. Never present that old mapping as current.
      if (report !== current) return { text: UNAVAILABLE_REPORT, rows: [] };
      return {
        text: formatReport(rows, visible),
        rows: buildInspectRows(rows, visible),
        report: current,
        visible,
      };
    };
    let pending = Promise.resolve();
    let stopped = false;
    const inspect = () => {
      const result = pending.then(async () => {
        const response = stopped ? { text: UNAVAILABLE_REPORT, rows: [] } : await readInspection();
        return { text: response.text, rows: response.rows };
      });
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    const explain = (input: unknown): Promise<ExplainResponse> => {
      if (
        !isPlainObject(input) ||
        typeof input.alias !== "string" ||
        input.alias.length === 0 ||
        Object.keys(input).some((key) => key !== "alias")
      ) {
        return Promise.reject(new Error("Expected { alias: <provider/alias> }"));
      }
      const alias = input.alias;
      const result = pending.then(async (): Promise<ExplainResponse> => {
        if (stopped) return { status: "unavailable" };
        if (!config.aliases.some((entry) => entry.key === alias))
          return { status: "unknown-alias" };
        const inspection = await readInspection();
        const explanation = inspection.report?.explanations.get(alias);
        // Escaped display keys are not identities: different raw keys can render
        // identically (for example a newline and a literal "\\u000a").
        const row = inspection.report?.rows.find((entry) => entry.key === alias);
        if (!explanation || !row) return { status: "unavailable" };
        const status =
          row.status === "unresolved"
            ? "unresolved"
            : inspection.visible?.has(alias)
              ? "active"
              : "inactive";
        return { status, explanation: structuredClone(explanation) };
      });
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    // Explicit reload of the discovered configuration file. Serialized with
    // inspect/explain through the same queue so a reload never interleaves
    // with an in-flight inspection.
    const doReload = async (): Promise<{ status: ReloadStatus }> => {
      const loaded = await loadEffectiveConfig(ctx.location.directory, ctx.options);
      if (!loaded.ok) return { status: "rejected" };
      let settled: ReloadStatus | undefined;
      staged = {
        config: loaded.config,
        settle: (status) => {
          settled = status;
        },
      };
      try {
        await ctx.model.reload();
      } catch {
        staged = null;
        // The host API failed, but its rebuild may already have run the
        // transform and committed the candidate (nothing pins "rejected
        // promise ⇒ nothing materialized" in the pinned host adapter):
        // reject only when nothing was settled, otherwise a changed
        // config would be live while the status says rejected.
        if (settled !== "reloaded") return { status: "rejected" };
      }
      try {
        await ctx.model.list();
      } catch {
        // The rebuild failed; the settlement below decides the outcome.
      }
      if (settled === undefined) {
        // The transform never ran (the host rebuild failed before the
        // replays): nothing was applied.
        staged = null;
        return { status: "rejected" };
      }
      if (settled === "rejected") return { status: "rejected" };
      // Success: reconfigure the live history instead of rehydrating from
      // storage: kept aliases preserve their in-memory entries — including
      // a transition whose storage.set() failed, which keeps its id while
      // the pending save is retried — removed aliases are pruned, and the
      // refreshed inspection snapshot keeps report and materialized
      // aliases consistent. Recreating from stale storage would discard
      // that unpersisted transition and re-emit a new one (fresh id).
      // The transaction is already committed here (the transform adopted
      // and materialized the candidate), so a refreshed inspection
      // reporting unavailability does not roll the reload back: the status
      // stays "reloaded" and inspect() self-heals on the next read.
      history.reconfigure(config.aliases);
      await readInspection();
      return { status: "reloaded" };
    };
    const reload = (): Promise<{ status: ReloadStatus }> => {
      const result = pending.then(async (): Promise<{ status: ReloadStatus }> => {
        if (stopped) return { status: "rejected" };
        return doReload();
      });
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    let rpcRegistration: { dispose: () => Promise<void> };
    try {
      rpcRegistration = await ctx.rpc.register(ModelAliasesRpc, { inspect, explain, reload });
    } catch (error) {
      await registration.dispose();
      throw error;
    }

    // Do not persist a baseline if RPC registration rejects and the setup group
    // rolls back. Queue the initial confirmation before listening for updates.
    pending = readInspection(initialCatalog).then(() => {});
    const abort = new AbortController();
    const watching = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (stopped) break;
          if (event.type !== "model.updated") continue;
          if (
            event.location &&
            (event.location.directory !== ctx.location.directory ||
              event.location.workspaceID !== ctx.location.workspaceID)
          )
            continue;
          await inspect();
        }
      } catch {
        // A closed event stream must not disable selection or inspection.
      }
    })();
    await pending;

    return async () => {
      stopped = true;
      abort.abort();
      await watching;
      await pending;
      // Cleanup in reverse registration order: first the RPC, then the
      // transform. Both dispose calls are idempotent.
      await rpcRegistration.dispose();
      await registration.dispose();
    };
  },
});
