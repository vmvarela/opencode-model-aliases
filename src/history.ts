import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { isPlainObject, type NormalizedAlias } from "./config.js";
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
  target: Target;
  transition?: AliasTransition;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Informational hash of the selection policy that confirmed the target.
 *  Configuration changes never invalidate history because of it: entries are
 *  identified by alias key and location, and the policy hash is only recorded
 *  for diagnostics when a new target is confirmed. */
function policyID(alias: NormalizedAlias): string {
  return hash([
    [...alias.match].sort(),
    [...alias.exclude].sort(),
    [...alias.statuses].sort(),
    alias.capabilities?.tools ?? null,
    [...(alias.capabilities?.input ?? [])].sort(),
    [...(alias.capabilities?.output ?? [])].sort(),
    alias.minContext ?? null,
    "latest",
  ]);
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
  const entries = new Map<string, Entry>();
  let dirty = false;
  try {
    const saved = await storage.get(storageKey);
    if (isPlainObject(saved) && saved.version === 1 && Array.isArray(saved.aliases)) {
      for (const value of saved.aliases) {
        // A confirmed target survives policy/configuration changes: the alias
        // key and location identify the entry. Keys no longer configured are
        // garbage collected (alias deletion, malformed shapes).
        if (
          !isPlainObject(value) ||
          typeof value.key !== "string" ||
          typeof value.policy !== "string" ||
          !policies.has(value.key) ||
          !isTarget(value.target)
        )
          continue;
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
      for (const alias of aliases) policies.set(alias.key, policyID(alias));
      for (const key of [...entries.keys()]) {
        if (!policies.has(key)) {
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
