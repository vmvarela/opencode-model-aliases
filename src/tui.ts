import type { Plugin } from "@opencode/plugin/tui";
import {
  type CandidateExplanation,
  formatCandidateDetail,
  formatExplanation,
  formatExplanationOverview,
  isExplainResponse,
} from "./explain.js";
import { type InspectReportRow, sanitize } from "./report.js";
import { ModelAliasesRpc } from "./rpc.js";
import { type AliasTransition, isAliasTransition } from "./transition.js";

const COMMAND_ID = "opencode-model-aliases.inspect";
const COMMAND_TITLE = "Model aliases";
const SLASH_COMMAND_NAME = "model-aliases";
const LOG_PREFIX = "[opencode-model-aliases]";

const USAGE_MESSAGE =
  'Unexpected arguments. Use /model-aliases or /model-aliases explain <provider/alias>. Quote the alias if it contains spaces: /model-aliases explain "<provider/alias>".';
const ERROR_MESSAGE = "Unable to load model aliases. Please reload or try again.";

export type InspectResponseRow = InspectReportRow;

export interface InspectResponse {
  readonly text: string;
  readonly rows: readonly InspectResponseRow[];
}

function isInspectRow(value: unknown): value is InspectResponseRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.identity !== "string" ||
    row.identity.length === 0 ||
    typeof row.key !== "string" ||
    typeof row.displayName !== "string" ||
    typeof row.provider !== "string" ||
    typeof row.alias !== "string" ||
    row.strategy !== "latest" ||
    (row.status !== "active" && row.status !== "inactive" && row.status !== "unresolved")
  ) {
    return false;
  }
  if (row.target !== undefined && typeof row.target !== "string") return false;
  if (row.catalogID !== undefined && typeof row.catalogID !== "string") return false;
  if (row.providerID !== undefined && typeof row.providerID !== "string") return false;
  if (row.wireModelID !== undefined && typeof row.wireModelID !== "string") return false;
  if (row.failureKind !== undefined && typeof row.failureKind !== "string") return false;
  if (row.failureReason !== undefined && typeof row.failureReason !== "string") return false;
  if (row.transition !== undefined && !isAliasTransition(row.transition)) return false;
  return true;
}

export function isInspectResponse(value: unknown): value is InspectResponse {
  if (typeof value !== "object" || value === null) return false;
  const res = value as Record<string, unknown>;
  if (typeof res.text !== "string" || !Array.isArray(res.rows)) return false;
  if (!res.rows.every(isInspectRow)) return false;
  // Duplicate identities would make selection ambiguous again: a compliant
  // backend can never emit them (identity is the row's raw key, unique per
  // configured alias).
  const identities = (res.rows as InspectResponseRow[]).map((row) => row.identity);
  return new Set(identities).size === identities.length;
}

function describeFailure(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

export function formatDetailMessage(row: InspectResponseRow): string {
  const lines: string[] = [`Alias: ${row.key}`, `Name: ${row.displayName}`];

  if (row.alias !== row.displayName) {
    lines.push(`Alias model ID: ${row.alias}`);
  }

  if (row.status === "unresolved") {
    lines.push(`Strategy: ${row.strategy}`);
    const kind = row.failureKind ? ` (${row.failureKind})` : "";
    lines.push(`Status: unresolved${kind}`);
    if (row.failureReason) {
      lines.push(`Reason: ${row.failureReason}`);
    }
  } else {
    const target =
      row.providerID && row.providerID !== row.provider && row.target
        ? `${row.providerID}/${row.target}`
        : (row.target ?? row.catalogID ?? "");
    lines.push(`Target: ${row.provider}/${target}`);
    if (row.wireModelID !== undefined && row.wireModelID !== row.catalogID) {
      lines.push(`Wire model ID: ${row.wireModelID}`);
    }
    lines.push(`Strategy: ${row.strategy}`);
    lines.push(
      row.status === "active" ? "Status: active" : "Status: inactive (not in final catalog)",
    );
  }

  if (row.transition) {
    const change = row.transition;
    lines.push(`Last change: ${change.from} → ${change.to}`);
    if (change.fromWireModelID !== change.toWireModelID) {
      lines.push(`Wire change: ${change.fromWireModelID} → ${change.toWireModelID}`);
    }
    lines.push(`Detected: ${change.changedAt}`);
  }
  return lines.join("\n");
}

const plugin = {
  id: "opencode-model-aliases",
  setup(context) {
    // Same opt-in as the server plugin's `debug` option. The TUI host swallows
    // console.debug/console.log from plugins, so diagnosis goes through
    // console.warn with a [debug] prefix.
    const debugEnabled = context.options?.debug === true;
    const debugLog = (message: string) => {
      if (debugEnabled) console.warn(`${LOG_PREFIX} [debug] ${message}`);
    };
    let stopped = false;
    let pending = Promise.resolve();
    // Snapshot durable acknowledgments into client-local memory. The native
    // store is live-synced between TUIs; an already open client may still show
    // a transition once, independently of another client's acknowledgement.
    const clients = new Map<
      string,
      {
        shown: Map<string, string>;
        unsaved: Map<string, string>;
        save: (mutation: (draft: { aliases: Record<string, string> }) => void) => Promise<void>;
      }
    >();
    const notify = () => {
      pending = pending
        .then(async () => {
          if (stopped) return;
          const location = context.location ?? context.data.location.default();
          const response = await context.client.rpc(ModelAliasesRpc).inspect({}, { location });
          if (stopped) return;
          if (!isInspectResponse(response)) {
            debugLog("discarded inspect response: malformed payload");
            return;
          }
          const currentLocation = context.location ?? context.data.location.default();
          if (
            location?.directory !== currentLocation?.directory ||
            location?.workspaceID !== currentLocation?.workspaceID
          ) {
            debugLog("discarded inspect response: active location changed while awaiting RPC");
            return;
          }
          const scope = JSON.stringify([location?.directory ?? "", location?.workspaceID ?? ""]);
          let client = clients.get(scope);
          if (!client) {
            const [saved, save] = context.storage.store<{ aliases: Record<string, string> }>(
              `notifications-v1/${scope}`,
              { initial: { aliases: {} } },
            );
            client = {
              shown: new Map(Object.entries(saved.aliases ?? {})),
              unsaved: new Map(),
              save,
            };
            clients.set(scope, client);
          }
          const { shown, unsaved, save } = client;
          // Acknowledgements are keyed by the lossless row identity (#56):
          // escaped keys are display text, not identities.
          const unseen = response.rows.filter(
            (row) =>
              row.status === "active" &&
              row.transition &&
              shown.get(row.identity) !== row.transition.id,
          );
          if (debugEnabled && unseen.length === 0) {
            const acknowledged: string[] = [];
            let withoutTransition = 0;
            let notActive = 0;
            for (const row of response.rows) {
              if (row.status !== "active") notActive += 1;
              else if (!row.transition) withoutTransition += 1;
              else acknowledged.push(row.key);
            }
            debugLog(
              `no notification: ${acknowledged.length} acknowledged (${acknowledged.join(", ")})` +
                `, ${withoutTransition} active without transition, ${notActive} not active`,
            );
          }
          if (unseen.length > 0) {
            const messages = unseen.slice(0, 3).map((row) => {
              const change = row.transition as AliasTransition;
              const wire =
                change.from === change.to
                  ? ` (wire: ${change.fromWireModelID} → ${change.toWireModelID})`
                  : "";
              return `${row.key}: ${change.from} → ${change.to}${wire}`;
            });
            if (unseen.length > 3) messages.push(`+${unseen.length - 3} more changes`);
            debugLog(`showing toast: ${unseen.map((row) => row.key).join(", ")}`);
            context.ui.toast.show({
              title: "Model aliases changed",
              message: `${messages.join("\n")}\nSee /model-aliases for details.`,
              variant: "info",
              duration: 6000,
            });
            for (const row of unseen) {
              const id = (row.transition as AliasTransition).id;
              shown.set(row.identity, id);
              unsaved.set(row.identity, id);
            }
          }
          // A failed disk write must remain retryable even though the toast
          // has already been acknowledged in this client's memory.
          if (unsaved.size > 0) {
            await save((draft) => {
              for (const [key, id] of unsaved) draft.aliases[key] = id;
            });
            unsaved.clear();
          }
        })
        .catch((error) => {
          // Notifications are optional; RPC/storage failures do not open dialogs
          // or break the manual inspection command.
          debugLog(`notification check failed: ${describeFailure(error)}`);
        });
      return pending;
    };
    const unlisten = context.data.on("model.updated", (event) => {
      const location = context.location ?? context.data.location.default();
      if (
        event.location &&
        (event.location.directory !== location?.directory ||
          event.location.workspaceID !== location?.workspaceID)
      )
        return;
      void notify();
    });
    void notify();
    const command = {
      id: COMMAND_ID,
      title: COMMAND_TITLE,
      palette: true as const,
      slash: {
        name: SLASH_COMMAND_NAME,
        arguments: true as const,
      },
      run: async (input?: string) => {
        const args = input?.trim() ?? "";
        // Alias keys may contain spaces; a quoted argument preserves the exact
        // key, while the unquoted form keeps the historical single-token shape.
        const explainMatch = /^explain\s+("([^"]*)"|(\S+))$/.exec(args);
        const quoted = explainMatch?.[2];
        const alias = quoted !== undefined ? quoted : explainMatch?.[3];
        if (explainMatch && alias !== undefined && alias.length > 0) {
          const location = context.location ?? context.data.location.default();
          try {
            const response = await context.client
              .rpc(ModelAliasesRpc)
              .explain({ alias }, { location });
            if (!isExplainResponse(response)) {
              await context.ui.dialog.alert({ title: COMMAND_TITLE, message: ERROR_MESSAGE });
              return;
            }
            if (response.status === "unknown-alias" || response.status === "unavailable") {
              await context.ui.dialog.alert({
                title: "Model alias explanation",
                message: formatExplanation(response),
              });
              return;
            }

            const report = response.explanation;
            if (report.candidates.length === 0) {
              await context.ui.dialog.alert({
                title: "Model alias explanation",
                message: formatExplanation(response),
              });
              return;
            }

            const compactStage = (name: string) => {
              if (name === "matching") return "match";
              if (name === "filtering") return "filter";
              if (name === "selection") return "select";
              return name;
            };

            const options: Array<{
              category?: string;
              title: string;
              description?: string;
              footer?: string;
              value: string;
            }> = [
              {
                category: "overview",
                title: "Overview",
                description: report.stages
                  .map((s) => `${compactStage(s.name)}: ${s.accepted}`)
                  .join(" → "),
                footer: response.status,
                value: "__overview__",
              },
            ];

            const providerPrefix = report.alias.includes("/")
              ? `${report.alias.split("/")[0]}/`
              : "";

            const selectedCandidates = report.candidates.filter((c) => c.outcome === "selected");
            const eligibleCandidates = report.candidates.filter((c) => c.outcome === "eligible");
            const rejectedCandidates = report.candidates.filter((c) => c.outcome === "rejected");

            // Explanation IDs are escaped display text, not identities: two raw
            // IDs can escape to the same string (a newline vs a literal
            // "\\u000a"). Selection values index the candidates losslessly.
            const valueOfCandidate = (candidate: CandidateExplanation) =>
              `__candidate_${report.candidates.indexOf(candidate)}`;
            const candidateByValue = new Map<string, CandidateExplanation>(
              report.candidates.map((candidate) => [valueOfCandidate(candidate), candidate]),
            );

            for (const candidate of [
              ...selectedCandidates,
              ...eligibleCandidates,
              ...rejectedCandidates,
            ]) {
              const title = candidate.id.startsWith(providerPrefix)
                ? candidate.id.slice(providerPrefix.length)
                : candidate.id;

              options.push({
                category: candidate.outcome,
                title,
                ...(candidate.outcome === "rejected" ? { footer: candidate.stage } : {}),
                value: valueOfCandidate(candidate),
              });
            }

            let current: string | undefined;
            while (true) {
              const selectedKey = await context.ui.dialog.select({
                title: `Model alias explanation: ${report.alias}`,
                placeholder: "Filter candidates...",
                options,
                ...(current === undefined ? {} : { current }),
              });

              if (selectedKey === undefined) {
                return;
              }
              current = selectedKey;

              let confirmed: boolean | undefined;
              if (selectedKey === "__overview__") {
                confirmed = await context.ui.dialog.confirm({
                  title: `Model alias explanation: ${report.alias}`,
                  message: formatExplanationOverview(response),
                  label: { confirm: "Back to candidates", cancel: "Exit" },
                });
              } else {
                const selectedCandidate = candidateByValue.get(selectedKey);
                if (selectedCandidate) {
                  confirmed = await context.ui.dialog.confirm({
                    title: `Candidate: ${selectedCandidate.id}`,
                    message: formatCandidateDetail(selectedCandidate),
                    label: { confirm: "Back to candidates", cancel: "Exit" },
                  });
                }
              }

              if (confirmed !== true) {
                return;
              }
            }
          } catch {
            await context.ui.dialog.alert({ title: COMMAND_TITLE, message: ERROR_MESSAGE });
          }
          return;
        }
        if (args !== "") {
          await context.ui.dialog.alert({
            title: COMMAND_TITLE,
            message: USAGE_MESSAGE,
          });
          return;
        }

        const location = context.location ?? context.data.location.default();

        try {
          const response = await context.client.rpc(ModelAliasesRpc).inspect({}, { location });
          if (!isInspectResponse(response)) {
            await context.ui.dialog.alert({
              title: COMMAND_TITLE,
              message: ERROR_MESSAGE,
            });
            return;
          }

          if (response.rows.length === 0) {
            await context.ui.dialog.alert({
              title: COMMAND_TITLE,
              message: response.text,
            });
            return;
          }

          const options = response.rows.map((row) => {
            let description: string;
            if (row.status === "unresolved") {
              const kind = row.failureKind ?? "unresolved";
              description = row.failureReason ? `${kind}: ${row.failureReason}` : kind;
            } else {
              description = row.target ?? row.catalogID ?? "";
            }

            let footer: string | undefined;
            if (row.status === "inactive") {
              footer = "inactive";
            } else if (row.status === "unresolved") {
              footer = "unresolved";
            }

            return {
              category: row.provider,
              title: row.displayName,
              description,
              ...(footer !== undefined ? { footer } : {}),
              // Selection value is the lossless identity (#56), never shown.
              value: row.identity,
            };
          });

          const selectedKey = await context.ui.dialog.select({
            title: COMMAND_TITLE,
            placeholder: "Filter aliases...",
            options,
          });

          if (selectedKey === undefined) {
            return;
          }

          const selectedRow = response.rows.find((r) => r.identity === selectedKey);
          if (!selectedRow) {
            return;
          }

          await context.ui.dialog.alert({
            title: `${COMMAND_TITLE}: ${selectedRow.displayName}`,
            message: formatDetailMessage(selectedRow),
          });
        } catch {
          await context.ui.dialog.alert({
            title: COMMAND_TITLE,
            message: ERROR_MESSAGE,
          });
        }
      },
    };

    const disposeSlot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [command],
        }));
        return null;
      },
    });
    return async () => {
      stopped = true;
      unlisten();
      disposeSlot();
      await pending;
    };
  },
} satisfies Plugin.Definition;

export default plugin;
