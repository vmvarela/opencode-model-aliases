import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Raíz temporal única por test; el lookup de config nunca toca el repo real. */
export function makeTempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "opencode-model-aliases-test-"));
}

export function removeTempRoot(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Escribe `.opencode/opencode-model-aliases.jsonc` en `dir` (crea el dir). */
export function writeConfigFile(dir: string, contents: string): string {
  const configDir = path.join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "opencode-model-aliases.jsonc");
  writeFileSync(file, contents, "utf8");
  return file;
}
