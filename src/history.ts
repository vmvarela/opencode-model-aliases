import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { isPlainObject, type NormalizedAlias, type SelectionStrategy } from "./config.js";
import type { AliasReportRow } from "./report.js";
import { type AliasTransition, isAliasTransition } from "./transition.js";

type Target = {
  providerID: string;
  catalogID: string;
  wireModelID: string;
};
type Entry = {
  key: string;
  policy: string;
  /** Ordered selection policy the target was confirmed under. */
  strategy: readonly string[];
  target: Target;
  transition?: AliasTransition;
};

/** Strategies admitted in persisted entries; anything else is malformed. */
const STRATEGIES: ReadonlySet<string> = new Set(["latest", "best", "cheapest"]);

/** Legacy entries (pre-#46) persisted no strategy: they mean ["latest"]. */
const LEGACY_STRATEGY: readonly SelectionStrategy[] = ["latest"];

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Informational hash of the alias policy that confirmed the target, including
 * the ordered selection policy. `policyID` is diagnostic: configuration
 * changes never invalidate history because of it — entries are identified by
 * alias key and location, and the ordered strategy change alone has its own
 * baseline-reset rule below.
 */
function policyID(alias: NormalizedAlias): string {
  return hash([
    [...alias.match].sort(),
    [...alias.exclude].sort(),
    [...alias.statuses].sort(),
    alias.capabilities?.tools ?? null,
    [...(alias.capabilities?.input ?? [])].sort(),
    [...(alias.capabilities?.output ?? [])].sort(),
    alias.minContext ?? null,
    alias.minAgeMs ?? null,
    [...alias.strategy],
  ]);
}

/** Same length and same order; the policy order is part of the identity. */
function sameStrategy(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** A persisted strategy must be a non-empty array of supported criteria. */
function isStrategyList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && STRATEGIES.has(entry))
  );
}

function isTarget(value: unknown): value is Target {
  return (
    isPlainObject(value) &&
    [value.providerID, value.catalogID, value.wireModelID].every(
      (part) => typeof part === "string" && part.length > 0,
    )
  );
}

/** Small state: one confirmed target and at most one transition per alias. */
export async function createHistory(
  storage: Plugin.Context["storage"],
  location: { readonly directory?: string | undefined; readonly workspaceID?: string | undefined },
  aliases: readonly NormalizedAlias[],
) {
  const storageKey = `history-v1/${hash([location.directory ?? "", location.workspaceID ?? ""])}`;
  const policies = new Map(aliases.map((alias) => [alias.key, policyID(alias)]));
  const strategies = new Map(aliases.map((alias) => [alias.key, alias.strategy]));
  const entries = new Map<string, Entry>();
  let dirty = false;
  try {
    const saved = await storage.get(storageKey);
    if (isPlainObject(saved) && saved.version === 1 && Array.isArray(saved.aliases)) {
      for (const value of saved.aliases) {
        // A confirmed target survives configuration changes: the alias key
        // and location identify the entry. Keys no longer configured are
        // garbage collected (alias deletion, malformed shapes).
        if (
          !isPlainObject(value) ||
          typeof value.key !== "string" ||
          typeof value.policy !== "string" ||
          !strategies.has(value.key) ||
          !isTarget(value.target)
        )
          continue;
        // Entries persisted before #46 have no strategy and mean ["latest"]:
        // they only survive while the configuration still holds that policy.
        // A present but malformed value is unusable, never treated as legacy.
        const storedStrategy =
          value.strategy === undefined ? LEGACY_STRATEGY : (value.strategy as unknown);
        if (!isStrategyList(storedStrategy)) continue;
        // An ordered strategy change alone resets the alias baseline: the
        // entry (target and transition) is dropped and re-confirmed from
        // scratch. Other policy changes keep the target as-is.
        if (!sameStrategy(storedStrategy, strategies.get(value.key) ?? [])) continue;
        // Copy only public, validated fields from untrusted JSON.
        const target = value.target;
        // A transition inconsistent with its own target makes the whole entry
        // unusable, not just the transition.
        if (
          value.transition !== undefined &&
          (!isAliasTransition(value.transition) ||
            value.transition.to !== `${target.providerID}/${target.catalogID}` ||
            value.transition.toWireModelID !== target.wireModelID)
        )
          continue;
        entries.set(value.key, {
          key: value.key,
          policy: value.policy,
          strategy: [...storedStrategy],
          target: {
            providerID: target.providerID,
            catalogID: target.catalogID,
            wireModelID: target.wireModelID,
          },
          ...(isAliasTransition(value.transition)
            ? {
                transition: {
                  id: value.transition.id,
                  from: value.transition.from,
                  to: value.transition.to,
                  fromWireModelID: value.transition.fromWireModelID,
                  toWireModelID: value.transition.toWireModelID,
                  changedAt: value.transition.changedAt,
                },
              }
            : {}),
        });
      }
      // Rewritten canonicalized state counts as dirty: dropped rows and
      // collapsed duplicate keys shrink `entries` below the saved length.
      dirty = entries.size !== saved.aliases.length;
    }
  } catch {
    // Persistence is best effort; resolution must work even if storage fails.
  }
  return {
    /**
     * Applies a new alias set on the live instance instead of rehydrating
     * from storage: kept aliases preserve their in-memory entries (dirty,
     * unpersisted transitions included — the same entry keeps its id and
     * the pending save is retried) and keys no longer configured are
     * pruned, marked for the next persistence retry. The stored `policy`
     * hash of a kept entry only refreshes when its target changes, exactly
     * like the hydration path.
     */
    reconfigure(aliases: readonly NormalizedAlias[]) {
      policies.clear();
      strategies.clear();
      for (const alias of aliases) {
        policies.set(alias.key, policyID(alias));
        strategies.set(alias.key, alias.strategy);
      }
      for (const key of [...entries.keys()]) {
        // Pruned keys (no longer configured) and kept keys whose ordered
        // selection policy changed both reset the alias baseline: the entry
        // is dropped here and re-confirmed from scratch by a later read,
        // while dirty/unpersisted state of untouched entries is preserved.
        const strategy = strategies.get(key);
        const entry = entries.get(key);
        const reset =
          strategy === undefined || entry === undefined || !sameStrategy(entry.strategy, strategy);
        if (reset) {
          entries.delete(key);
          dirty = true;
        }
      }
    },
    async observe(rows: readonly AliasReportRow[], visible: ReadonlySet<string>) {
      for (const row of rows) {
        if (row.status !== "resolved" || !visible.has(row.key) || !row.providerID || !row.catalogID)
          continue;
        const policy = policies.get(row.key);
        if (!policy) continue;
        const target = {
          providerID: row.providerID,
          catalogID: row.catalogID,
          wireModelID: row.wireModelID ?? row.catalogID,
        };
        const previous = entries.get(row.key);
        if (
          previous &&
          previous.target.providerID === target.providerID &&
          previous.target.catalogID === target.catalogID &&
          previous.target.wireModelID === target.wireModelID
        )
          continue;
        entries.set(row.key, {
          key: row.key,
          policy,
          strategy: [...(strategies.get(row.key) ?? [])],
          target,
          ...(previous
            ? {
                transition: {
                  id: randomUUID(),
                  from: `${previous.target.providerID}/${previous.target.catalogID}`,
                  to: `${target.providerID}/${target.catalogID}`,
                  fromWireModelID: previous.target.wireModelID,
                  toWireModelID: target.wireModelID,
                  changedAt: new Date().toISOString(),
                },
              }
            : {}),
        });
        dirty = true;
      }
      if (dirty) {
        try {
          await storage.set(storageKey, { version: 1, aliases: [...entries.values()] });
          dirty = false;
        } catch {
          // Retry the same state on the next confirmed read, without a fake change.
        }
      }
      return rows.map((row) => {
        const transition = entries.get(row.key)?.transition;
        return transition ? { ...row, transition } : row;
      });
    },
  };
}
