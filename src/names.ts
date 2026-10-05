const ALIAS_SUFFIX = " (alias)";

/**
 * Nombre visible por defecto, determinista a partir del modelID del alias
 * (último segmento, separadores como espacios, primera letra mayúscula):
 * "sonnet" → "Sonnet (alias)".
 */
export function defaultAliasName(modelID: string): string {
  const segment = modelID.split("/").pop() ?? "";
  const label = segment
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return `${label}${ALIAS_SUFFIX}`;
}

/**
 * Nombre visible de un alias: el `name` configurado se usa intacto; si se
 * omite, se genera con la MISMA regla que la materialización del catálogo.
 */
export function aliasDisplayName(alias: {
  readonly name: string;
  readonly nameExplicit: boolean;
  readonly modelID: string;
}): string {
  return alias.nameExplicit ? alias.name : defaultAliasName(alias.modelID);
}
