import type { Candidate, NormalizedAlias } from "./config.js";
import type { FailureKind } from "./errors.js";
import { aliasDisplayName } from "./names.js";
import type { ResolveResult } from "./resolve.js";
import type { AliasTransition } from "./transition.js";

/** Row status: the alias resolved or stayed unresolved (tolerant). */
export type AliasReportStatus = "resolved" | "unresolved";

/** Status evaluated against the final catalog: active, inactive (retired/disabled) or unresolved. */
export type InspectRowStatus = "active" | "inactive" | "unresolved";

/**
 * Structured inspection row: public primitive data with the final status.
 * Consumed by the TUI to render the native interactive list (dialog.select)
 * and the concise per-alias detail without parsing the text report.
 */
export interface InspectReportRow {
  readonly transition?: AliasTransition;
  readonly key: string;
  readonly provider: string;
  /** Visible name: the configured name kept intact, or the default generated one. */
  readonly displayName: string;
  readonly alias: string;
  readonly strategy: "latest";
  readonly status: InspectRowStatus;
  readonly target?: string;
  readonly catalogID?: string;
  readonly providerID?: string;
  readonly wireModelID?: string;
  readonly failureKind?: string;
  readonly failureReason?: string;
}

/**
 * Report row: ONLY public primitive data. Never full Model.Info, settings,
 * headers, body, credentials or configuration objects.
 */
export interface AliasReportRow {
  readonly transition?: AliasTransition;
  /** Alias reference `<provider>/<model>` (configuration key). */
  readonly key: string;
  /** Only implemented strategy. */
  readonly strategy: "latest";
  readonly status: AliasReportStatus;
  /** Visible name: the configured name kept intact, or the default generated one. */
  readonly displayName: string;
  /** Only resolved: the real winner from the catalog. */
  readonly providerID?: string;
  readonly catalogID?: string;
  /** Only resolved: the execution modelID (wire); reported separately. */
  readonly wireModelID?: string;
  /** Only unresolved. */
  readonly failureKind?: FailureKind;
  readonly failureReason?: string;
}

/**
 * Static unavailability message: the last replay failed, the catalog could
 * not be read, or the published mapping could not be confirmed against the
 * final catalog (a later policy changed the identity of the alias). A
 * previous/stale snapshot or the raw error is never served.
 */
export const UNAVAILABLE_REPORT =
  "Model alias inspection is unavailable: the current alias mapping could not be confirmed against the final catalog.";

/** C0/C1 control characters (including ESC/CSI and \x7F) — not safe in a TTY. */
const CONTROL = /\p{Cc}/gu;

/** Replaces control characters with their `\uXXXX` escape; no other changes. */
export function sanitize(value: string): string {
  return value.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Builds report rows from the SAME resolution results the transform uses to
 * materialize. No extra queries.
 */
export function buildRows<T extends Candidate & { readonly modelID?: string }>(
  results: ReadonlyArray<{ alias: NormalizedAlias; result: ResolveResult<T> }>,
): AliasReportRow[] {
  return results.map(({ alias, result }) => {
    const displayName = aliasDisplayName(alias);
    if (result.ok) {
      const wire = result.model.modelID;
      return {
        key: alias.key,
        strategy: "latest",
        status: "resolved",
        displayName,
        providerID: result.model.providerID,
        catalogID: result.model.id,
        // The execution modelID is only reported separately when it differs.
        ...(wire !== undefined && wire !== result.model.id ? { wireModelID: wire } : {}),
      } as AliasReportRow;
    }
    return {
      key: alias.key,
      strategy: "latest",
      status: "unresolved",
      displayName,
      failureKind: result.failure.kind,
      failureReason: result.failure.reason,
    } as AliasReportRow;
  });
}

/**
 * Converts resolution rows into structured inspection rows evaluated against
 * the final catalog visibility. Public primitive data sorted deterministically
 * by key (code unit order).
 */
export function buildInspectRows(
  rows: ReadonlyArray<AliasReportRow>,
  visible: ReadonlySet<string>,
): InspectReportRow[] {
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted.map((row) => {
    const slash = row.key.indexOf("/");
    const provider = slash !== -1 ? row.key.slice(0, slash) : row.key;
    const alias = slash !== -1 ? row.key.slice(slash + 1) : row.key;
    const key = sanitize(row.key);
    const safeProvider = sanitize(provider);
    const safeAlias = sanitize(alias);
    const safeDisplayName = sanitize(row.displayName);
    const transition = row.transition
      ? {
          transition: Object.fromEntries(
            Object.entries(row.transition).map(([key, value]) => [key, sanitize(value)]),
          ) as unknown as AliasTransition,
        }
      : {};

    if (row.status === "unresolved") {
      return {
        ...transition,
        key,
        provider: safeProvider,
        displayName: safeDisplayName,
        alias: safeAlias,
        strategy: "latest",
        status: "unresolved",
        ...(row.failureKind ? { failureKind: sanitize(row.failureKind) } : {}),
        ...(row.failureReason ? { failureReason: sanitize(row.failureReason) } : {}),
      };
    }

    const isActive = visible.has(row.key);
    const status: InspectRowStatus = isActive ? "active" : "inactive";
    const catalogID = row.catalogID ? sanitize(row.catalogID) : undefined;
    const providerID = row.providerID ? sanitize(row.providerID) : undefined;
    const wireModelID =
      row.wireModelID !== undefined && row.wireModelID !== row.catalogID
        ? sanitize(row.wireModelID)
        : undefined;

    const target =
      providerID && providerID !== safeProvider && catalogID !== undefined
        ? `${providerID}/${catalogID}`
        : catalogID;

    return {
      ...transition,
      key,
      provider: safeProvider,
      displayName: safeDisplayName,
      alias: safeAlias,
      strategy: "latest",
      status,
      ...(target !== undefined ? { target } : {}),
      ...(catalogID !== undefined ? { catalogID } : {}),
      ...(providerID !== undefined ? { providerID } : {}),
      ...(wireModelID !== undefined ? { wireModelID } : {}),
    };
  });
}

/**
 * Deterministic format: provider-grouped report with a compact summary.
 * Rows are grouped by the literal provider of the alias key and sorted by
 * key (code unit order). Each alias shows its visible name as the primary
 * label, with the alias modelID in parentheses only when it differs, and its
 * target indented on the next line, without redundant prefixes or repetitive
 * labels; incidents (inactive or unresolved) and the execution wire modelID
 * (when it differs) are highlighted explicitly.
 */
export function formatReport(
  rows: ReadonlyArray<AliasReportRow>,
  visible: ReadonlySet<string>,
): string {
  if (rows.length === 0) return "No aliases configured.";

  const total = rows.length;
  const totalLabel = `${total} alias${total === 1 ? "" : "es"}`;
  const activeCount = rows.filter((r) => r.status === "resolved" && visible.has(r.key)).length;
  const inactiveCount = rows.filter((r) => r.status === "resolved" && !visible.has(r.key)).length;
  const unresolvedCount = rows.filter((r) => r.status === "unresolved").length;

  let summary: string;
  if (inactiveCount === 0 && unresolvedCount === 0) {
    summary = `${totalLabel} · ${activeCount} active`;
  } else {
    const statusParts = [`${activeCount} active`];
    if (inactiveCount > 0) {
      statusParts.push(`${inactiveCount} inactive`);
    }
    if (unresolvedCount > 0) {
      statusParts.push(`${unresolvedCount} unresolved`);
    }
    summary = `${totalLabel} · ${statusParts.join(" · ")}`;
  }

  // Grouping by the provider of the alias key.
  const groups = new Map<string, AliasReportRow[]>();
  for (const row of rows) {
    const slash = row.key.indexOf("/");
    const provider = slash !== -1 ? row.key.slice(0, slash) : row.key;
    let list = groups.get(provider);
    if (!list) {
      list = [];
      groups.set(provider, list);
    }
    list.push(row);
  }

  const sortedProviders = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sections = sortedProviders.map((provider) => {
    const providerRows = [...(groups.get(provider) ?? [])].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const aliasBlocks = providerRows.map((row) => {
      const slash = row.key.indexOf("/");
      const aliasName = slash !== -1 ? row.key.slice(slash + 1) : row.key;
      const safeDisplayName = sanitize(row.displayName);
      const safeAlias = sanitize(aliasName);
      // Primary label = displayName; the alias modelID is only shown in
      // parentheses when it differs from the visible name.
      const aliasLabel =
        row.displayName === aliasName ? safeDisplayName : `${safeDisplayName} (${safeAlias})`;

      if (row.status === "unresolved") {
        const kind = sanitize(row.failureKind ?? "unknown");
        const reason = row.failureReason ? `: ${sanitize(row.failureReason)}` : "";
        return `  ${aliasLabel}\n    → unresolved (${kind})${reason}${formatTransition(row)}`;
      }

      const target =
        row.providerID && row.providerID !== provider
          ? `${sanitize(row.providerID)}/${sanitize(row.catalogID ?? "")}`
          : sanitize(row.catalogID ?? "");

      let targetLine = `    → ${target}`;
      if (row.wireModelID !== undefined && row.wireModelID !== row.catalogID) {
        targetLine += ` (wire model ID: ${sanitize(row.wireModelID)})`;
      }
      if (!visible.has(row.key)) {
        targetLine += " (inactive: not in final catalog)";
      }
      return `  ${aliasLabel}\n${targetLine}${formatTransition(row)}`;
    });

    return `${sanitize(provider)}\n${aliasBlocks.join("\n")}`;
  });

  return `Model aliases (strategy: latest)\n${summary}\n\n${sections.join("\n\n")}`;
}

function formatTransition(row: AliasReportRow): string {
  const change = row.transition;
  if (!change) return "";
  const wire =
    change.fromWireModelID === change.toWireModelID
      ? ""
      : ` (wire: ${sanitize(change.fromWireModelID)} → ${sanitize(change.toWireModelID)})`;
  return `\n    Last change: ${sanitize(change.from)} → ${sanitize(change.to)}${wire}\n    Detected: ${sanitize(change.changedAt)}`;
}
