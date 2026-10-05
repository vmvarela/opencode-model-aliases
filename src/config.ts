/** Actual statuses of Model.Info. */
export type ModelStatus = "alpha" | "beta" | "deprecated" | "active";

/** Plain object (not null, not array); valid container for options/aliases. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Statuses accepted in filter.status; `deprecated` is always rejected. */
export type AllowedStatus = Exclude<ModelStatus, "deprecated">;

export interface FilterOptions {
  /** Defaults to ["active"]; non-empty list of active/alpha/beta. */
  status?: AllowedStatus[];
}

export interface SelectOptions {
  /** Required when select is declared; the whole object may be omitted. */
  strategy: "latest";
}

export interface AliasConfig {
  /** Fully qualified include globs `provider/glob`. */
  match: string | string[];
  /** Fully qualified exclude globs `provider/glob`. */
  exclude?: string | string[];
  filter?: FilterOptions;
  select?: SelectOptions;
  /** Optional visible name; must be non-empty. */
  name?: string;
}

export interface Options {
  /** Keys `<provider>/<model>`; the provider is the part before the first `/`. */
  aliases: Record<string, AliasConfig>;
  strict?: boolean;
  debug?: boolean;
}

/**
 * Minimal contract of the resolver; the fields are the ones used by the
 * matching, filtering and selection stages. Model.Info from @opencode/plugin
 * is compliant.
 */
export interface Candidate {
  readonly id: string;
  readonly providerID: string;
  readonly enabled: boolean;
  readonly status: ModelStatus;
  readonly time: { readonly released: number };
}

export type Checker = (id: string) => boolean;

/** Normalized alias: compiled matchers + filter + strategy + name. */
export interface NormalizedAlias {
  /** Original key `<provider>/<model>`. */
  readonly key: string;
  /** Literal provider of the key. */
  readonly provider: string;
  /** Model part of the key; it may contain `/`. */
  readonly modelID: string;
  readonly match: readonly string[];
  readonly exclude: readonly string[];
  readonly includes: readonly Checker[];
  readonly excludes: readonly Checker[];
  /** Defaults to ["active"]. */
  readonly statuses: readonly AllowedStatus[];
  /** Configured name or, when omitted, the key itself. */
  readonly name: string;
  /** true only when the user configured `name` explicitly. */
  readonly nameExplicit: boolean;
}

export interface NormalizedConfig {
  /** Preserves the insertion order of the keys. */
  readonly aliases: readonly NormalizedAlias[];
  readonly strict: boolean;
  readonly debug: boolean;
}
