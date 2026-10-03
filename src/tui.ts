import type { Plugin } from "@opencode/plugin/tui";
import { ModelAliasesRpc } from "./rpc.js";

const COMMAND_ID = "opencode-model-aliases.inspect";
const COMMAND_TITLE = "Model aliases";
const SLASH_COMMAND_NAME = "model-aliases";

const USAGE_MESSAGE =
  "Unexpected arguments. Use /model-aliases without arguments to view configured model aliases.";
const ERROR_MESSAGE = "Unable to load model aliases. Please reload or try again.";

interface InspectResponse {
  readonly text: string;
}

function isInspectResponse(value: unknown): value is InspectResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as { text: unknown }).text === "string"
  );
}

const plugin = {
  id: "opencode-model-aliases",
  setup(context) {
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
          if (isInspectResponse(response)) {
            await context.ui.dialog.alert({
              title: COMMAND_TITLE,
              message: response.text,
            });
            return;
          }
          await context.ui.dialog.alert({
            title: COMMAND_TITLE,
            message: ERROR_MESSAGE,
          });
        } catch {
          await context.ui.dialog.alert({
            title: COMMAND_TITLE,
            message: ERROR_MESSAGE,
          });
        }
      },
    };

    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [command],
        }));
        return null;
      },
    });
  },
} satisfies Plugin.Definition;

export default plugin;
