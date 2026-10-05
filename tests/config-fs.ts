import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Unique temporary root per test; the config lookup never touches the real repo. */
export function makeTempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "opencode-model-aliases-test-"));
}

export function removeTempRoot(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Writes `.opencode/opencode-model-aliases.jsonc` into `dir` (creates the dir). */
export function writeConfigFile(dir: string, contents: string): string {
  const configDir = path.join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "opencode-model-aliases.jsonc");
  writeFileSync(file, contents, "utf8");
  return file;
}
