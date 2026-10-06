import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { isPlainObject, type NormalizedAlias } from "./config.js";
import type { AliasReportRow } from "./report.js";
import { type AliasTransition, isAliasTransition } from "./transition.js";

interface Target {
  providerID: string;
  catalogID: string;
  wireModelID: string;
}
interface Entry {
  key: string;
  policy: string;
  target: Target;
  transition?: AliasTransition;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Display names, debug and strict do not change the selection policy. */
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
        if (
          !isPlainObject(value) ||
          typeof value.key !== "string" ||
          typeof value.policy !== "string" ||
          policies.get(value.key) !== value.policy ||
          !isTarget(value.target) ||
          (value.transition !== undefined && !isAliasTransition(value.transition))
        )
          continue;
        // Copy only public, validated fields from untrusted JSON.
        const target = value.target;
        const transition = value.transition as AliasTransition | undefined;
        if (
          transition &&
          (transition.to !== `${target.providerID}/${target.catalogID}` ||
            transition.toWireModelID !== target.wireModelID)
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
          ...(transition
            ? {
                transition: {
                  id: transition.id,
                  from: transition.from,
                  to: transition.to,
                  fromWireModelID: transition.fromWireModelID,
                  toWireModelID: transition.toWireModelID,
                  changedAt: transition.changedAt,
                },
              }
            : {}),
        });
      }
      dirty = entries.size !== saved.aliases.length;
    }
  } catch {
    // Persistence is best effort; resolution must work even if storage fails.
  }
  return {
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
        if (previous && JSON.stringify(previous.target) === JSON.stringify(target)) continue;
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
          // Round-trip strips optional undefined fields to the SDK's JSON type.
          await storage.set(
            storageKey,
            JSON.parse(JSON.stringify({ version: 1, aliases: [...entries.values()] })),
          );
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
