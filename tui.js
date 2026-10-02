// Envoltorio runtime del paquete: re-exporta el TUI compilado del plugin.
// El TUI importa únicamente el contrato RPC (dist/rpc.js), nunca el barrel
// del backend.
export { default } from "./dist/tui.js";
