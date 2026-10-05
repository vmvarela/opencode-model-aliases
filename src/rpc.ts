import type { Rpc } from "@opencode/plugin";

/**
 * Public RPC contract of the plugin, consumed by the TUI (which imports only
 * this module, never the backend barrel): id "opencode-model-aliases" and a
 * single `inspect` method with empty object input and `{ text }` output, no
 * events. Portable definition built from plain JSON Schema objects, no schema
 * library at runtime (pinned @opencode/plugin 2.0.16).
 */
export const ModelAliasesRpc = {
  id: "opencode-model-aliases",
  methods: {
    inspect: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                provider: { type: "string" },
                displayName: { type: "string" },
                alias: { type: "string" },
                strategy: { type: "string", enum: ["latest"] },
                status: { type: "string", enum: ["active", "inactive", "unresolved"] },
                target: { type: "string" },
                catalogID: { type: "string" },
                providerID: { type: "string" },
                wireModelID: { type: "string" },
                failureKind: { type: "string" },
                failureReason: { type: "string" },
              },
              required: ["key", "provider", "displayName", "alias", "strategy", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "rows"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
