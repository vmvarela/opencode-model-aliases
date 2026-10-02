/** Distinguishable failure kinds for Phase 2 diagnostics. */
export type FailureKind =
  /** Options did not normalize (malformed alias, bad pattern, bad status…). */
  | "parse-error"
  /** Source list was empty before any stage ran. */
  | "no-candidates"
  /** Candidates existed but all were dropped by matching/filtering. */
  | "no-eligible"
  /** Eligible candidates existed but none has a reliable timestamp. */
  | "missing-metadata";

export interface ResolveFailure {
  kind: FailureKind;
  reason: string;
}

export function failure(kind: FailureKind, reason: string): ResolveFailure {
  return { kind, reason };
}
