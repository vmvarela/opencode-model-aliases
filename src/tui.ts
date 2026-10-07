import type { Plugin } from "@opencode/plugin/tui";
import type { InspectReportRow } from "./report.js";
import { ModelAliasesRpc } from "./rpc.js";
import { type AliasTransition, isAliasTransition } from "./transition.js";

const COMMAND_ID = "opencode-model-aliases.inspect";
const COMMAND_TITLE = "Model aliases";
const SLASH_COMMAND_NAME = "model-aliases";

const USAGE_MESSAGE =
  "Unexpected arguments. Use /model-aliases without arguments to view configured model aliases.";
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
  return res.rows.every(isInspectRow);
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
          if (stopped || !isInspectResponse(response)) return;
          const currentLocation = context.location ?? context.data.location.default();
          if (
            location?.directory !== currentLocation?.directory ||
            location?.workspaceID !== currentLocation?.workspaceID
          )
            return;
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
          const unseen = response.rows.filter(
            (row) =>
              row.status === "active" && row.transition && shown.get(row.key) !== row.transition.id,
          );
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
            context.ui.toast.show({
              title: "Model aliases changed",
              message: `${messages.join("\n")}\nSee /model-aliases for details.`,
              variant: "info",
              duration: 6000,
            });
            for (const row of unseen) {
              const id = (row.transition as AliasTransition).id;
              shown.set(row.key, id);
              unsaved.set(row.key, id);
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
        .catch(() => {
          // Notifications are optional; RPC/storage failures do not open dialogs
          // or break the manual inspection command.
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
        if (input !== undefined && input.trim() !== "") {
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
              value: row.key,
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

          const selectedRow = response.rows.find((r) => r.key === selectedKey);
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
