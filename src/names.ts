const ALIAS_SUFFIX = " (alias)";

/**
 * Default visible name, deterministic from the alias modelID (last segment,
 * separators as spaces, first letter capitalized): "sonnet" → "Sonnet (alias)".
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
 * Visible name of an alias: the configured `name` is kept intact; when it is
 * omitted, it is generated with the SAME rule as catalog materialization.
 */
export function aliasDisplayName(alias: {
  readonly name: string;
  readonly nameExplicit: boolean;
  readonly modelID: string;
}): string {
  return alias.nameExplicit ? alias.name : defaultAliasName(alias.modelID);
}
