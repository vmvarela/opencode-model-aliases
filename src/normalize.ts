import picomatch from "picomatch";
import type {
  AllowedStatus,
  CapabilityRequirement,
  Checker,
  NormalizedAlias,
  NormalizedConfig,
  Options,
} from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";

const DEFAULT_STATUSES: readonly AllowedStatus[] = ["active"];
const ALLOWED_STATUSES: ReadonlySet<string> = new Set(["active", "alpha", "beta"]);

/** Keys accepted per configuration level; anything else is a typo and is rejected. */
const ROOT_KEYS: readonly string[] = ["aliases", "strict", "debug"];
const ALIAS_KEYS: readonly string[] = ["match", "exclude", "filter", "select", "name"];
const FILTER_KEYS: readonly string[] = ["status", "capabilities", "minContext"];
const CAPABILITY_KEYS: readonly string[] = ["tools", "input", "output"];

/**
 * Single compile and matching semantics. `strictBrackets` rejects unbalanced
 * brackets and `debug: true` forces picomatch to throw while building the
 * regex (e.g. inverted ranges like [z-a]) instead of accepting them.
 */
const MATCHER_OPTIONS = {
  dot: true,
  nonegate: true,
  strictBrackets: true,
  debug: true,
} as const;

/** `<provider>/<model>`; provider before the first `/`; the model may contain `/`. */
export type Selector = { provider: string; modelID: string };

export function splitSelector(value: string): Selector | ResolveFailure {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return failure("parse-error", `"${value}" must be fully qualified as "<provider>/<model>"`);
  }
  return { provider: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * picomatch metacharacters, including the extglob syntax (+ @ ! ( ) |),
 * escapes and alternations. A valid provider cannot contain them.
 */
const PROVIDER_META = /[*?[\]{}()!+@|\\]/;

/** A literal provider contains no extglob, glob or escape syntax. */
export function isLiteralProvider(provider: string): boolean {
  return provider.length > 0 && !PROVIDER_META.test(provider);
}

function prefix(fail: ResolveFailure, context: string): ResolveFailure {
  return failure(fail.kind, `${context}: ${fail.reason}`);
}

/** Own enumerable keys outside the supported list. */
function unknownKeys(value: Record<string, unknown>, supported: readonly string[]): string[] {
  const allowed = new Set(supported);
  return Object.keys(value).filter((key) => !allowed.has(key));
}

/** Narrows a normalizer result union (`T | undefined | ResolveFailure`). */
function isFailure(value: unknown): value is ResolveFailure {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** Uniform reason for unrecognized keys: it always names the typo. */
function unsupportedKeysMessage(keys: readonly string[], supported: readonly string[]): string {
  return `unsupported key(s): ${keys.join(", ")} (supported: ${supported.join(", ")})`;
}

/** Compiles a fully qualified glob with strict validation; it never throws. */
function compileGlob(pattern: string, context: string): Checker | ResolveFailure {
  if (pattern.includes("#")) {
    return failure("parse-error", `${context}: pattern "${pattern}" must not contain "#"`);
  }
  const head = splitSelector(pattern);
  if ("kind" in head) return prefix(head, context);
  if (!isLiteralProvider(head.provider)) {
    return failure(
      "parse-error",
      `${context}: pattern "${pattern}" provider "${head.provider}" must be literal`,
    );
  }
  try {
    return picomatch(pattern, MATCHER_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("parse-error", `${context}: invalid glob "${pattern}": ${message}`);
  }
}

function normalizePatternList(
  value: unknown,
  kind: "match" | "exclude",
  provider: string,
  context: string,
): { raw: string[]; checkers: Checker[] } | ResolveFailure {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (kind === "match" && list.length === 0) {
    return failure("parse-error", `${context}: match must contain at least one glob`);
  }
  const raw: string[] = [];
  const checkers: Checker[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0) {
      return failure("parse-error", `${context}: ${kind} entries must be non-empty strings`);
    }
    const compiled = compileGlob(entry, context);
    if ("kind" in compiled) return compiled;
    const head = splitSelector(entry);
    if ("kind" in head) return prefix(head, context);
    // Per-alias isolation: the literal provider must match exactly.
    if (head.provider !== provider) {
      return failure(
        "parse-error",
        `${context}: ${kind} pattern "${entry}" targets provider "${head.provider}" but alias provider is "${provider}"`,
      );
    }
    raw.push(entry);
    checkers.push(compiled);
  }
  return { raw, checkers };
}

function normalizeFilterStatus(value: unknown, context: string): AllowedStatus[] | ResolveFailure {
  if (value === undefined) return [...DEFAULT_STATUSES];
  if (!Array.isArray(value) || value.length === 0) {
    return failure("parse-error", `${context}: filter.status must be a non-empty array of strings`);
  }
  const out: AllowedStatus[] = [];
  for (const entry of value) {
    if (!ALLOWED_STATUSES.has(entry as string)) {
      return failure(
        "parse-error",
        `${context}: filter.status value ${JSON.stringify(entry)} is not allowed`,
      );
    }
    out.push(entry as AllowedStatus);
  }
  return out;
}

/** Validates one modality list: non-empty array of non-empty strings. */
function normalizeModalityList(
  value: unknown,
  key: "input" | "output",
  context: string,
): readonly string[] | undefined | ResolveFailure {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return failure(
      "parse-error",
      `${context}: filter.capabilities.${key} must be a non-empty array of non-empty strings`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return failure(
        "parse-error",
        `${context}: filter.capabilities.${key} entries must be non-empty strings`,
      );
    }
  }
  return [...value];
}

/**
 * Capability requirements: an object with optional `tools` (exact boolean),
 * `input`/`output` (all-of modality lists). Modality strings are open-ended;
 * unknown keys and malformed values are rejected.
 */
function normalizeCapabilityFilter(
  value: unknown,
  context: string,
): CapabilityRequirement | undefined | ResolveFailure {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    return failure("parse-error", `${context}: filter.capabilities must be an object`);
  }
  const extras = unknownKeys(value, CAPABILITY_KEYS);
  if (extras.length > 0) {
    return failure(
      "parse-error",
      `${context}: filter.capabilities ${unsupportedKeysMessage(extras, CAPABILITY_KEYS)}`,
    );
  }
  if (value.tools === undefined && value.input === undefined && value.output === undefined) {
    // Only optional fields: no requirement is declared; normalize to no-op so
    // missing capability metadata is never treated as a failing requirement.
    return undefined;
  }
  if (value.tools !== undefined && typeof value.tools !== "boolean") {
    return failure("parse-error", `${context}: filter.capabilities.tools must be a boolean`);
  }
  const input = normalizeModalityList(value.input, "input", context);
  if (input !== undefined && "kind" in input) return input;
  const output = normalizeModalityList(value.output, "output", context);
  if (output !== undefined && "kind" in output) return output;
  return {
    ...(value.tools !== undefined ? { tools: value.tools } : {}),
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
}

/** Positive integer context window requirement. */
function normalizeMinContext(value: unknown, context: string): number | undefined | ResolveFailure {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return failure("parse-error", `${context}: filter.minContext must be a positive integer`);
  }
  return value;
}

function normalizeSelect(value: unknown, context: string): { strategy: "latest" } | ResolveFailure {
  if (value === undefined) return { strategy: "latest" };
  if (!isPlainObject(value)) {
    return failure(
      "parse-error",
      `${context}: select must be an object like { strategy: "latest" }`,
    );
  }
  if (value.strategy !== "latest") {
    return failure("parse-error", `${context}: select.strategy must be "latest"`);
  }
  const extra = unknownKeys(value, ["strategy"]);
  if (extra.length > 0) {
    return failure(
      "parse-error",
      `${context}: select ${unsupportedKeysMessage(extra, ["strategy"])}`,
    );
  }
  return { strategy: "latest" };
}

function normalizeAlias(key: string, value: unknown): NormalizedAlias | ResolveFailure {
  const context = `alias "${key}"`;
  if (key.includes("#")) {
    return failure("parse-error", `${context}: must not contain "#"`);
  }
  const head = splitSelector(key);
  if ("kind" in head) return prefix(head, context);
  if (!isLiteralProvider(head.provider)) {
    return failure("parse-error", `${context}: provider "${head.provider}" must be literal`);
  }
  if (!isPlainObject(value)) {
    return failure("parse-error", `${context}: must be an object`);
  }
  const aliasExtras = unknownKeys(value, ALIAS_KEYS);
  if (aliasExtras.length > 0) {
    return failure("parse-error", `${context}: ${unsupportedKeysMessage(aliasExtras, ALIAS_KEYS)}`);
  }
  if (value.match === undefined) {
    return failure("parse-error", `${context}: match is required`);
  }
  const filter = value.filter;
  if (filter !== undefined && !isPlainObject(filter)) {
    return failure("parse-error", `${context}: filter must be an object`);
  }
  if (isPlainObject(filter)) {
    const filterExtras = unknownKeys(filter, FILTER_KEYS);
    if (filterExtras.length > 0) {
      return failure(
        "parse-error",
        `${context}: filter ${unsupportedKeysMessage(filterExtras, FILTER_KEYS)}`,
      );
    }
  }

  const includes = normalizePatternList(value.match, "match", head.provider, context);
  if ("kind" in includes) return includes;
  const excludes = normalizePatternList(value.exclude, "exclude", head.provider, context);
  if ("kind" in excludes) return excludes;
  const statuses = normalizeFilterStatus(
    isPlainObject(filter) ? filter.status : undefined,
    context,
  );
  if ("kind" in statuses) return statuses;
  const capabilities = normalizeCapabilityFilter(
    isPlainObject(filter) ? filter.capabilities : undefined,
    context,
  );
  if (isFailure(capabilities)) return capabilities;
  const minContext = normalizeMinContext(
    isPlainObject(filter) ? filter.minContext : undefined,
    context,
  );
  if (isFailure(minContext)) return minContext;
  const select = normalizeSelect(value.select, context);
  if ("kind" in select) return select;
  const name = value.name;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    return failure("parse-error", `${context}: name must be a non-empty string`);
  }

  return {
    key,
    provider: head.provider,
    modelID: head.modelID,
    match: includes.raw,
    exclude: excludes.raw,
    includes: includes.checkers,
    excludes: excludes.checkers,
    statuses,
    ...(capabilities ? { capabilities } : {}),
    ...(minContext !== undefined ? { minContext } : {}),
    name: name === undefined ? key : name,
    nameExplicit: name !== undefined,
  };
}

export function normalizeOptions(
  options: Options,
): { ok: true; config: NormalizedConfig } | { ok: false; failure: ResolveFailure } {
  if (!isPlainObject(options)) {
    return { ok: false, failure: failure("parse-error", "options must be an object") };
  }
  // Root typos (e.g. "strcit") are rejected before any other validation:
  // silent whitelisting would hide them.
  const rootExtras = unknownKeys(options, ROOT_KEYS);
  if (rootExtras.length > 0) {
    return {
      ok: false,
      failure: failure("parse-error", `root ${unsupportedKeysMessage(rootExtras, ROOT_KEYS)}`),
    };
  }
  if (!isPlainObject(options.aliases)) {
    return {
      ok: false,
      failure: failure("parse-error", "aliases must be an object ({} is a valid no-op)"),
    };
  }
  if (options.strict !== undefined && typeof options.strict !== "boolean") {
    return { ok: false, failure: failure("parse-error", "strict must be a boolean") };
  }
  if (options.debug !== undefined && typeof options.debug !== "boolean") {
    return { ok: false, failure: failure("parse-error", "debug must be a boolean") };
  }

  const aliases: NormalizedAlias[] = [];
  for (const [key, value] of Object.entries(options.aliases)) {
    const alias = normalizeAlias(key, value);
    if ("kind" in alias) return { ok: false, failure: alias };
    aliases.push(alias);
  }

  return {
    ok: true,
    config: {
      aliases,
      strict: options.strict ?? false,
      debug: options.debug ?? false,
    },
  };
}
