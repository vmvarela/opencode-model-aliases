// Runtime wrapper for the package: re-exports the plugin's compiled TUI.
// The TUI imports only the RPC contract (dist/rpc.js), never the backend
// barrel.
export { default } from "./dist/tui.js";
