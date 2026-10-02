/** Estatus reales de Model.Info. */
export type ModelStatus = "alpha" | "beta" | "deprecated" | "active";

/** Objeto plano (no null, no array); contenedor válido para options/aliases. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Estatus admitidos en filter.status; `deprecated` se rechaza siempre. */
export type AllowedStatus = Exclude<ModelStatus, "deprecated">;

export interface FilterOptions {
  /** Por defecto ["active"]; lista no vacía de active/alpha/beta. */
  status?: AllowedStatus[];
}

export interface SelectOptions {
  /** Obligatoria cuando se declara select; el objeto completo puede omitirse. */
  strategy: "latest";
}

export interface AliasConfig {
  /** Globs include totalmente cualificados `provider/glob`. */
  match: string | string[];
  /** Globs exclude totalmente cualificados `provider/glob`. */
  exclude?: string | string[];
  filter?: FilterOptions;
  select?: SelectOptions;
  /** Nombre visible opcional; no vacío. */
  name?: string;
}

export interface Options {
  /** Claves `<provider>/<model>`; el proveedor es la parte anterior al primer `/`. */
  aliases: Record<string, AliasConfig>;
  strict?: boolean;
  debug?: boolean;
}

/**
 * Contrato mínimo del resolvedor; los campos son los usados por las etapas de
 * matching, filtering y selection. Model.Info de @opencode/plugin es conforme.
 */
export interface Candidate {
  readonly id: string;
  readonly providerID: string;
  readonly enabled: boolean;
  readonly status: ModelStatus;
  readonly time: { readonly released: number };
}

export type Checker = (id: string) => boolean;

/** Alias normalizado: matchers compilados + filtro + estrategia + nombre. */
export interface NormalizedAlias {
  /** Clave original `<provider>/<model>`. */
  readonly key: string;
  /** Proveedor literal de la clave. */
  readonly provider: string;
  /** Parte modelo de la clave; puede contener `/`. */
  readonly modelID: string;
  readonly match: readonly string[];
  readonly exclude: readonly string[];
  readonly includes: readonly Checker[];
  readonly excludes: readonly Checker[];
  /** Por defecto ["active"]. */
  readonly statuses: readonly AllowedStatus[];
  /** name configurado o, si se omite, la propia clave. */
  readonly name: string;
  /** true solo cuando el usuario configuró `name` explícitamente. */
  readonly nameExplicit: boolean;
}

export interface NormalizedConfig {
  /** Preserva el orden de inserción de las claves. */
  readonly aliases: readonly NormalizedAlias[];
  readonly strict: boolean;
  readonly debug: boolean;
}
