import picomatch from "picomatch";
import type {
  AllowedStatus,
  Checker,
  NormalizedAlias,
  NormalizedConfig,
  Options,
} from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";

const DEFAULT_STATUSES: readonly AllowedStatus[] = ["active"];
const ALLOWED_STATUSES: ReadonlySet<string> = new Set(["active", "alpha", "beta"]);

/**
 * Semántica única de compilación y matching. `strictBrackets` rechaza
 * corchetes desbalanceados y `debug: true` obliga a picomatch a lanzar al
 * construir la regex (p. ej. rangos invertidos como [z-a]) en vez de aceptarlos.
 */
const MATCHER_OPTIONS = {
  dot: true,
  nonegate: true,
  strictBrackets: true,
  debug: true,
} as const;

/** `<provider>/<model>`; proveedor antes del primer `/`, el modelo puede contener `/`. */
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
 * Metacaracteres de picomatch, incluida la sintaxis extglob (+ @ ! ( ) |),
 * escapes y alternaciones. Un proveedor válido no puede contenerlos.
 */
const PROVIDER_META = /[*?[\]{}()!+@|\\]/;

/** Un proveedor literal no contiene sintaxis extglob, glob ni escapes. */
export function isLiteralProvider(provider: string): boolean {
  return provider.length > 0 && !PROVIDER_META.test(provider);
}

function prefix(fail: ResolveFailure, context: string): ResolveFailure {
  return failure(fail.kind, `${context}: ${fail.reason}`);
}

/** Compila un glob totalmente cualificado validando estrictamente; nunca lanza. */
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
    // Aislamiento por alias: el proveedor literal debe coincidir exactamente.
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
  const extra = Object.keys(value).filter((k) => k !== "strategy");
  if (extra.length > 0) {
    return failure("parse-error", `${context}: select has unsupported key(s): ${extra.join(", ")}`);
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
  if (value.match === undefined) {
    return failure("parse-error", `${context}: match is required`);
  }
  const filter = value.filter;
  if (filter !== undefined && !isPlainObject(filter)) {
    return failure("parse-error", `${context}: filter must be an object`);
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
