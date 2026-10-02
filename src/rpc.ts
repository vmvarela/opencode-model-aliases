import type { Rpc } from "@opencode/plugin";

/**
 * Contrato RPC público del plugin, consumido por el TUI (que importa solo
 * este módulo, nunca el barrel del backend): id "opencode-model-aliases" y
 * un único método `inspect` con entrada objeto vacío y salida `{ text }`,
 * sin eventos. Definición portable en objetos planos JSON Schema, sin
 * librería de esquemas en runtime (pin @opencode/plugin 2.0.16).
 */
export const ModelAliasesRpc = {
  id: "opencode-model-aliases",
  methods: {
    inspect: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
