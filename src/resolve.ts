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

/** True when `modalityList` is an array containing every required modality. */
function containsAll(modalityList: unknown, required: readonly string[]): boolean {
  return Array.isArray(modalityList) && required.every((entry) => modalityList.includes(entry));
}

/**
 * Eligibility requirement checks (never ranking). Missing capability or
 * context metadata fails a configured requirement.
 */
function meetsRequirements(candidate: Candidate, alias: NormalizedAlias): boolean {
  const requirements = alias.capabilities;
  if (requirements) {
    const capabilities = candidate.capabilities;
    if (!capabilities) return false;
    if (requirements.tools !== undefined && capabilities.tools !== requirements.tools) {
      return false;
    }
    if (requirements.input && !containsAll(capabilities.input, requirements.input)) return false;
    if (requirements.output && !containsAll(capabilities.output, requirements.output)) return false;
  }
  if (alias.minContext !== undefined) {
    const context = candidate.limit?.context;
    if (typeof context !== "number" || !Number.isFinite(context) || context < alias.minContext) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministic, leak-free description of the configured requirements:
 * names and thresholds only, never model/provider ids or private metadata.
 */
function requirementSummary(alias: NormalizedAlias): string {
  const parts: string[] = [];
  const requirements = alias.capabilities;
  if (requirements) {
    if (requirements.tools !== undefined) {
      parts.push(`capabilities.tools=${requirements.tools}`);
    }
    if (requirements.input) {
      parts.push(`capabilities.input includes [${requirements.input.join(", ")}]`);
    }
    if (requirements.output) {
      parts.push(`capabilities.output includes [${requirements.output.join(", ")}]`);
    }
  }
  if (alias.minContext !== undefined) {
    parts.push(`minContext>=${alias.minContext}`);
  }
  return parts.join("; ");
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

  // Stage 2: filtering — enabled + statuses + configured capability/context
  // requirements, all AND together in the eligibility stage.
  const statusEligible = matched.filter(
    (candidate) => candidate.enabled !== false && alias.statuses.includes(candidate.status),
  );
  const eligible = statusEligible.filter((candidate) => meetsRequirements(candidate, alias));
  stages.push({ name: "filtering", accepted: eligible.length });
  if (eligible.length === 0) {
    // Keep the old diagnostic when enabled/status checks already dropped
    // everyone; otherwise the new requirements are the identifiable cause.
    if (statusEligible.length === 0) {
      return {
        ok: false,
        failure: failure("no-eligible", "no candidate passed enabled/status filtering"),
      };
    }
    return {
      ok: false,
      failure: failure(
        "no-eligible",
        `no candidate satisfied all configured requirements (${requirementSummary(alias)})`,
      ),
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
