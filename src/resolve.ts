import type { Candidate, NormalizedAlias } from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";
import type { CandidateExplanation, ResolutionExplanation } from "./explain.js";
import { sanitize } from "./report.js";

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
  const released = candidate.time?.released;
  return typeof released === "number" && Number.isFinite(released) && released > 0 ? released : 0;
}

/** True when `modalityList` is an array containing every required modality. */
function containsAll(modalityList: unknown, required: readonly string[]): boolean {
  return Array.isArray(modalityList) && required.every((entry) => modalityList.includes(entry));
}

/**
 * Claves de los requisitos configurados que un candidato incumple
 * individualmente, en orden fijo (tools, input, output, minContext).
 * Metadatos de capability o contexto ausentes incumplen el requisito
 * correspondiente.
 */
function unmetRequirements(candidate: Candidate, alias: NormalizedAlias): string[] {
  const unmet: string[] = [];
  const requirements = alias.capabilities;
  const capabilities = candidate.capabilities;
  if (requirements) {
    if (requirements.tools !== undefined && capabilities?.tools !== requirements.tools) {
      unmet.push("tools");
    }
    if (requirements.input && !containsAll(capabilities?.input, requirements.input)) {
      unmet.push("input");
    }
    if (requirements.output && !containsAll(capabilities?.output, requirements.output)) {
      unmet.push("output");
    }
  }
  if (alias.minContext !== undefined) {
    const context = candidate.limit?.context;
    if (typeof context !== "number" || !Number.isFinite(context) || context < alias.minContext) {
      unmet.push("minContext");
    }
  }
  return unmet;
}

/**
 * Descripción determinista y sin fugas de las claves de requisitos dadas, en
 * orden fijo y con sus valores configurados: solo nombres y umbrales, nunca
 * ids de modelo/provider ni metadatos privados.
 */
function requirementSummary(alias: NormalizedAlias, keys: ReadonlySet<string>): string {
  const parts: string[] = [];
  const requirements = alias.capabilities;
  if (requirements?.tools !== undefined && keys.has("tools")) {
    parts.push(`capabilities.tools=${requirements.tools}`);
  }
  if (requirements?.input && keys.has("input")) {
    parts.push(`capabilities.input includes [${requirements.input.join(", ")}]`);
  }
  if (requirements?.output && keys.has("output")) {
    parts.push(`capabilities.output includes [${requirements.output.join(", ")}]`);
  }
  if (alias.minContext !== undefined && keys.has("minContext")) {
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
): ResolveResult<T> & { explanation: ResolutionExplanation } {
  const stages: Stage[] = [];
  const explanation: ResolutionExplanation = {
    alias: sanitize(alias.key),
    strategy: "latest",
    stages,
    unmatched: 0,
    candidates: [],
  };
  const details: Array<{ id: string; detail: CandidateExplanation }> = [];
  const fail = (stage: Stage["name"], kind: ResolveFailure["kind"], reason: string) => {
    explanation.failure = { stage, code: kind, message: sanitize(reason) };
    return { ok: false as const, failure: failure(kind, reason), explanation };
  };
  if (!Array.isArray(models)) {
    return fail("matching", "no-candidates", "source list must be an array");
  }

  // Record decisions where they are made; never run a second resolver for explain.
  const matched = models.flatMap((candidate) => {
    const id = canonical(candidate);
    if (candidate.providerID !== alias.provider) {
      explanation.unmatched++;
      return [];
    }
    const included = alias.includes.map((check) => check(id));
    const patterns = alias.match.filter((_, index) => included[index]);
    if (!included.some(Boolean)) {
      explanation.unmatched++;
      return [];
    }
    const exclusions = alias.excludes.map((check) => check(id));
    const excluded = alias.exclude.filter((_, index) => exclusions[index]);
    const detail: CandidateExplanation = {
      id: sanitize(id),
      matchedPatterns: patterns.map(sanitize),
      stage: "matching",
      outcome: "rejected",
      reasons: [],
    };
    details.push({ id, detail });
    if (exclusions.some(Boolean)) {
      detail.reasons.push({
        code: "excluded-pattern",
        message: `Excluded by ${excluded.map(sanitize).join(", ")}`,
      });
    }
    return exclusions.some(Boolean) ? [] : [{ candidate, detail }];
  });
  // Sort raw IDs, before escaping, using locale-independent code unit order.
  explanation.candidates = details
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ detail }) => detail);
  stages.push({ name: "matching", accepted: matched.length });
  if (matched.length === 0) {
    return models.length === 0
      ? fail("matching", "no-candidates", "source list is empty")
      : fail("matching", "no-eligible", "no candidate matched match/exclude patterns");
  }

  const statusEligible = matched.filter(({ candidate, detail }) => {
    detail.stage = "filtering";
    if (candidate.enabled === false)
      detail.reasons.push({ code: "disabled", message: "Model is disabled" });
    if (!alias.statuses.includes(candidate.status))
      detail.reasons.push({
        code: "status-not-allowed",
        message: `Status "${sanitize(candidate.status)}" is not allowed`,
      });
    return detail.reasons.length === 0;
  });
  const unmet = new Set<string>();
  const eligible = statusEligible.filter(({ candidate, detail }) => {
    const keys = unmetRequirements(candidate, alias);
    for (const key of keys) {
      unmet.add(key);
      const value =
        key === "minContext"
          ? candidate.limit?.context
          : candidate.capabilities?.[key as "tools" | "input" | "output"];
      const missing =
        key === "minContext"
          ? typeof value !== "number" || !Number.isFinite(value)
          : key === "tools"
            ? typeof value !== "boolean"
            : !Array.isArray(value);
      detail.reasons.push({
        code: missing ? "missing-metadata" : "requirement-not-met",
        message: `${missing ? "Missing or invalid metadata for" : "Does not satisfy"} ${sanitize(requirementSummary(alias, new Set([key])))}`,
      });
    }
    return keys.length === 0;
  });
  stages.push({ name: "filtering", accepted: eligible.length });
  if (eligible.length === 0) {
    return fail(
      "filtering",
      "no-eligible",
      statusEligible.length === 0
        ? "no candidate passed enabled/status filtering"
        : `no candidate satisfied all configured requirements (unmet across the candidate set: ${requirementSummary(alias, unmet)})`,
    );
  }

  const known = eligible.filter(({ candidate, detail }) => {
    detail.stage = "selection";
    const released = releasedMs(candidate);
    if (released === 0) {
      detail.reasons.push({
        code: "missing-metadata",
        message: "Missing or invalid time.released timestamp",
      });
      return false;
    }
    detail.released = released;
    return true;
  });
  stages.push({ name: "selection", accepted: known.length > 0 ? 1 : 0 });
  if (known.length === 0) {
    return fail(
      "selection",
      "missing-metadata",
      "no eligible candidate has a reliable time.released timestamp",
    );
  }
  const sorted = [...known].sort(({ candidate: a }, { candidate: b }) => {
    const delta = releasedMs(b) - releasedMs(a);
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const first = sorted[0];
  if (!first) return fail("selection", "no-eligible", "selection produced no candidate");
  const winner = first.candidate;
  const second = sorted[1]?.candidate;
  const tied = second !== undefined && releasedMs(second) === releasedMs(winner);
  for (const { candidate, detail } of sorted) {
    detail.outcome = candidate === winner ? "selected" : "eligible";
    const tie = releasedMs(candidate) === releasedMs(winner);
    detail.reasons.push(
      candidate === winner
        ? {
            code: tied ? "id-tiebreak" : "newest-release",
            message: tied
              ? "Newest release; won the descending model ID tie-break"
              : "Newest eligible candidate with a reliable release timestamp",
          }
        : {
            code: tie ? "id-tiebreak" : "older-release",
            message: tie
              ? "Same release timestamp; lost the descending model ID tie-break"
              : "Older release than the selected candidate",
          },
    );
  }
  explanation.winner = sanitize(canonical(winner));
  return { ok: true, model: winner, stages, explanation };
}
