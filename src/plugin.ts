import { type Model, Plugin } from "@opencode/plugin";
import { isPlainObject, type NormalizedConfig, type Options } from "./config.js";
import { loadConfigFile } from "./config-file.js";
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
}

/**
 * One transform replay. Per v2 semantics, each replay starts from the fresh
 * source catalog (no output from previous replays): snapshot once, collision
 * checked against that snapshot, single resolution per alias, and
 * materialization. No alias feeds another.
 *
 * Returns report rows built from the SAME resolution results used to
 * materialize; the caller only publishes them if the whole replay (including
 * materialization) succeeded.
 */
function replay(config: NormalizedConfig, editor: FloatingEditor): AliasReportRow[] {
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
  // and materialization.
  const results = config.aliases.map((alias) => ({
    alias,
    result: resolveLatest(snapshot, alias),
  }));

  if (config.strict) {
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

  return buildRows(results);
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    // Load the nearest configuration file BEFORE registering any
    // transform: a read/parse/merge failure leaves zero transforms
    // registered.
    const loaded = await loadConfigFile(ctx.location.directory);
    if (!loaded.ok) {
      throw new Error(`${LOG_PREFIX} invalid configuration: ${sanitize(loaded.reason)}`);
    }
    const fileOptions = loaded.file?.options;

    // Untrusted input; merged with the file as base and the inline host
    // values with priority. Full validation happens in normalizeOptions
    // over the merged result.
    const inline = ctx.options as unknown;
    if (inline !== undefined && inline !== null && !isPlainObject(inline)) {
      throw new Error(`${LOG_PREFIX} invalid configuration: options must be an object`);
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
      throw new Error(
        `${LOG_PREFIX} invalid configuration: aliases must be an object ({} is a valid no-op)`,
      );
    }
    if (fileOptions?.aliases !== undefined || inlineAliases !== undefined) {
      merged.aliases = {
        ...fileOptions?.aliases,
        ...(isPlainObject(inlineAliases) ? inlineAliases : {}),
      };
    }

    const normalized = normalizeOptions(merged as unknown as Options);
    if (!normalized.ok) {
      throw new Error(
        `${LOG_PREFIX} invalid configuration: ${sanitize(normalized.failure.reason)}`,
      );
    }

    const history = await createHistory(ctx.storage, ctx.location, normalized.config.aliases);

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
    let reportRows: readonly AliasReportRow[] | null = null;

    const registration = await ctx.model.transform((hostEditor) => {
      try {
        // Single host→adapter boundary: the host DeepMutable degrades strings
        // with brand; here it is adapted to the clean editor view.
        const rows = replay(normalized.config, hostEditor as unknown as FloatingEditor);
        reportRows = rows;
      } catch (error) {
        reportRows = null;
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
      const snapshot = reportRows;
      if (snapshot === null) {
        return { text: UNAVAILABLE_REPORT, rows: [] };
      }
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
      return {
        text: formatReport(rows, visible),
        rows: buildInspectRows(rows, visible),
      };
    };
    let pending = Promise.resolve();
    let stopped = false;
    const inspect = () => {
      const result = pending.then(() =>
        stopped ? { text: UNAVAILABLE_REPORT, rows: [] } : readInspection(),
      );
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    let rpcRegistration: { dispose: () => Promise<void> };
    try {
      rpcRegistration = await ctx.rpc.register(ModelAliasesRpc, { inspect });
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
