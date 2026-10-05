import type { Candidate, NormalizedAlias } from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";

export interface Stage {
  name: "matching" | "filtering" | "selection";
  accepted: number;
}

export type ResolveResult<T> =
  | { ok: true; model: T; stages: Stage[] }
  | { ok: false; failure: ResolveFailure };

/** Canonical identifier `<providerID>/<id>` used by matching and exclusions. */
function canonical(candidate: Candidate): string {
  return `${candidate.providerID}/${candidate.id}`;
}

/** Reliable date: finite number greater than 0 (milliseconds). */
function releasedMs(candidate: Candidate): number {
  const released = candidate.time.released;
  return typeof released === "number" && Number.isFinite(released) && released > 0 ? released : 0;
}

/**
 * Pure selection from the provided source list. No side effects and no
 * mutation of the input; the resolver never adds models derived from aliases
 * outside the explicit list.
 */
export function resolveLatest<T extends Candidate>(
  models: readonly T[],
  alias: NormalizedAlias,
): { ok: true; model: T; stages: Stage[] } | { ok: false; failure: ResolveFailure } {
  if (!Array.isArray(models)) {
    return { ok: false, failure: failure("no-candidates", "source list must be an array") };
  }
  const stages: Stage[] = [];

  // Stage 1: matching — includes and excludes against the canonical id.
  const matched = models.filter((candidate) => {
    // Defense in depth: provider equality does not depend on the matchers.
    if (candidate.providerID !== alias.provider) return false;
    const id = canonical(candidate);
    if (!alias.includes.some((check) => check(id))) return false;
    return !alias.excludes.some((check) => check(id));
  });
  stages.push({ name: "matching", accepted: matched.length });
  if (matched.length === 0) {
    return {
      ok: false,
      failure:
        models.length === 0
          ? failure("no-candidates", "source list is empty")
          : failure("no-eligible", "no candidate matched match/exclude patterns"),
    };
  }

  // Stage 2: filtering — enabled + statuses accepted by the alias.
  const eligible = matched.filter(
    (candidate) => candidate.enabled !== false && alias.statuses.includes(candidate.status),
  );
  stages.push({ name: "filtering", accepted: eligible.length });
  if (eligible.length === 0) {
    return {
      ok: false,
      failure: failure("no-eligible", "no candidate passed enabled/status filtering"),
    };
  }

  // Stage 3: selection — latest; unknown dates never win.
  const known = eligible.filter((candidate) => releasedMs(candidate) > 0);
  if (known.length === 0) {
    return {
      ok: false,
      failure: failure(
        "missing-metadata",
        "no eligible candidate has a reliable time.released timestamp",
      ),
    };
  }
  const sorted = [...known].sort((a, b) => {
    const delta = releasedMs(b) - releasedMs(a);
    if (delta !== 0) return delta;
    if (a.id === b.id) return 0;
    // Descending, code unit order, locale-independent.
    return a.id < b.id ? 1 : -1;
  });
  const winner = sorted[0];
  if (!winner) {
    return { ok: false, failure: failure("no-eligible", "selection produced no candidate") };
  }
  return { ok: true, model: winner, stages: [...stages, { name: "selection", accepted: 1 }] };
}
