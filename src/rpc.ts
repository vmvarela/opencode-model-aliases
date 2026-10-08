import type { Rpc } from "@opencode/plugin";

const stageSchema = { type: "string", enum: ["matching", "filtering", "selection"] } as const;
const reasonProperties = { code: { type: "string" }, message: { type: "string" } } as const;

/**
 * Public RPC contract of the plugin, consumed by the TUI (which imports only
 * this module, never the backend barrel): id "opencode-model-aliases" with
 * `inspect` and opt-in `explain` methods, no events. Portable definition built from plain JSON Schema objects, no schema
 * library at runtime (pinned @opencode/plugin 2.0.16).
 */
export const ModelAliasesRpc = {
  id: "opencode-model-aliases",
  methods: {
    explain: {
      input: {
        type: "object",
        properties: { alias: { type: "string", minLength: 1 } },
        required: ["alias"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "inactive", "unresolved", "unknown-alias", "unavailable"],
          },
          explanation: {
            type: "object",
            properties: {
              alias: { type: "string" },
              strategy: { type: "string", enum: ["latest"] },
              unmatched: { type: "integer", minimum: 0 },
              winner: { type: "string" },
              stages: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: stageSchema, accepted: { type: "integer", minimum: 0 } },
                  required: ["name", "accepted"],
                  additionalProperties: false,
                },
              },
              failure: {
                type: "object",
                properties: { ...reasonProperties, stage: stageSchema },
                required: ["code", "message", "stage"],
                additionalProperties: false,
              },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    matchedPatterns: { type: "array", items: { type: "string" } },
                    stage: stageSchema,
                    outcome: { type: "string", enum: ["selected", "eligible", "rejected"] },
                    released: { type: "number", exclusiveMinimum: 0 },
                    reasons: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: reasonProperties,
                        required: ["code", "message"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["id", "matchedPatterns", "stage", "outcome", "reasons"],
                  additionalProperties: false,
                },
              },
            },
            required: ["alias", "strategy", "unmatched", "stages", "candidates"],
            additionalProperties: false,
          },
        },
        required: ["status"],
        additionalProperties: false,
      },
    },
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
                transition: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    from: { type: "string" },
                    to: { type: "string" },
                    fromWireModelID: { type: "string" },
                    toWireModelID: { type: "string" },
                    changedAt: { type: "string" },
                  },
                  required: ["id", "from", "to", "fromWireModelID", "toWireModelID", "changedAt"],
                  additionalProperties: false,
                },
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
