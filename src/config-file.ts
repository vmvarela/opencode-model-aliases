import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { isPlainObject } from "./config.js";

/** Directory + file name of the plugin configuration file. */
const CONFIG_DIR = ".opencode";
const FILE_NAME = "opencode-model-aliases.jsonc";

/** Raw options read from the file; values are not validated yet.
 *  Unrecognized root keys are preserved as-is: normalizeOptions
 *  must reject them as parse-error (no silent whitelisting).
 *  The single exception is `$schema`: file-only metadata, validated and
 *  stripped before it can reach the merge (see loadConfigFile). */
export interface RawFileOptions {
  readonly aliases?: Record<string, unknown>;
  readonly strict?: unknown;
  readonly debug?: unknown;
  readonly [key: string]: unknown;
}

export interface LoadedConfigFile {
  /** Path of the first existing file found (already validated). */
  readonly path: string;
  readonly options: RawFileOptions;
}

export type LoadConfigFileResult =
  | { ok: true; file?: LoadedConfigFile }
  | { ok: false; reason: string };

/**
 * Finds the nearest configuration file by walking up from
 * `startDirectory` to the filesystem root. The first existing
 * `<dir>/.opencode/opencode-model-aliases.jsonc` wins: multiple ancestor
 * files are not merged and global directories are not consulted.
 * ENOENT keeps walking up; any other I/O error (EISDIR, EACCES…) fails
 * with path and code, without dumping file contents.
 */
export async function loadConfigFile(startDirectory: string): Promise<LoadConfigFileResult> {
  let current = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(current, CONFIG_DIR, FILE_NAME);
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) return { ok: true };
        current = parent;
        continue;
      }
      return {
        ok: false,
        reason: `config file "${candidate}" could not be read (code: ${code ?? "unknown"})`,
      };
    }

    // The parser is failure-tolerant: without inspecting `errors` it would
    // accept partial data as if it were valid.
    const errors: ParseError[] = [];
    const data = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      if (!first) return { ok: false, reason: `config file "${candidate}" has malformed JSONC` };
      return {
        ok: false,
        reason: `config file "${candidate}" has malformed JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      };
    }
    if (!isPlainObject(data)) {
      return {
        ok: false,
        reason: `config file "${candidate}" must contain a JSONC object at the root`,
      };
    }
    if (data.aliases !== undefined && !isPlainObject(data.aliases)) {
      return {
        ok: false,
        reason: `config file "${candidate}": aliases must be an object ({} is a valid no-op)`,
      };
    }

    // `$schema` is the only root key with file-level semantics: it names
    // the JSON Schema for editor support and is not part of the plugin
    // options. Accepted here as a non-empty string, never forwarded to
    // the merge: inline options have no `$schema` channel, so
    // normalizeOptions keeps rejecting it as an unknown root key.
    const { $schema: metadata, ...rest } = data;
    if (metadata !== undefined && (typeof metadata !== "string" || metadata.length === 0)) {
      return {
        ok: false,
        reason: `config file "${candidate}": $schema must be a non-empty string`,
      };
    }

    // All other own keys of the file are preserved, including unknown
    // ones: whitelisting would hide root typos before validation. The
    // rest spread copies each key as an own data property, safe against
    // hostile "__proto__" keys. The aliases container was already
    // validated above, hence the cast.
    const options = rest as RawFileOptions;
    return { ok: true, file: { path: candidate, options } };
  }
}
