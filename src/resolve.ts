import type { Candidate, NormalizedAlias, SelectionStrategy } from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";
import type { CandidateExplanation, ResolutionExplanation } from "./explain.js";
import { sanitize } from "./report.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

/** `<n>`-suffixed label of an age in milliseconds (whole hours or days). */
function minAgeLabel(ms: number): string {
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${ms / HOUR_MS}h`;
}

/**
 * Criterion signals injected by the host integration, keyed by canonical
 * candidate id `<providerID>/<id>`. Values live outside Candidate so the
 * resolver never invents quality or pricing data: a criterion whose signal
 * has no usable value for a candidate excludes it from the current tied
 * group, and if no candidate can provide a value the alias stays unresolved.
 */
export interface SelectionSignals {
  /** Quality score; a higher value wins. */
  readonly best?: ReadonlyMap<string, number>;
  /** Comparison cost; a lower value wins. */
  readonly cheapest?: ReadonlyMap<string, number>;
}

/** Loss verdict for the members defeated by one criterion's ordering. */
const LOSS_REASON: Readonly<Record<SelectionStrategy, { code: string; message: string }>> = {
  latest: { code: "older-release", message: "Older release than the selected candidate" },
  best: { code: "lower-score", message: "Lower quality score than the selected candidate" },
  cheapest: {
    code: "higher-cost",
    message: "Higher comparison cost than the selected candidate",
  },
};

/** Exclusion verdict for the members without usable metadata for one criterion. */
const MISSING_REASON: Readonly<Record<SelectionStrategy, { code: string; message: string }>> = {
  latest: { code: "missing-metadata", message: "Missing or invalid time.released timestamp" },
  best: {
    code: "missing-metadata",
    message: "Missing or invalid quality score (best) metadata",
  },
  cheapest: {
    code: "missing-metadata",
    message: "Missing or invalid comparison cost (cheapest) metadata",
  },
};

/** Unresolved message when no member of a tied group has usable criterion data. */
const MISSING_POLICY_MESSAGE: Readonly<Record<SelectionStrategy, string>> = {
  latest: "no eligible candidate has a reliable time.released timestamp",
  best: "no eligible candidate has usable quality score (best) metadata",
  cheapest: "no eligible candidate has usable comparison cost (cheapest) metadata",
};

type CriterionValue = { readonly usable: boolean; readonly value: number };

/**
 * Usable values per criterion: release timestamps come from the candidate,
 * quality scores and comparison costs from the injected signals keyed by
 * canonical id. Only finite numbers are usable.
 */
function criterionValue(
  strategy: SelectionStrategy,
  candidate: Candidate,
  signals: SelectionSignals | undefined,
): CriterionValue {
  if (strategy === "latest") {
    const released = releasedMs(candidate);
    return released > 0 ? { usable: true, value: released } : { usable: false, value: 0 };
  }
  const map = strategy === "best" ? signals?.best : signals?.cheapest;
  const value = map?.get(canonical(candidate));
  return typeof value === "number" && Number.isFinite(value)
    ? { usable: true, value }
    : { usable: false, value: 0 };
}

/**
 * Pure selection from the provided source list. No side effects and no
 * mutation of the input; the resolver never adds models derived from aliases
 * outside the explicit list.
 */
export function resolveLatest<T extends Candidate>(
  models: readonly T[],
  alias: NormalizedAlias,
  now: number = Date.now(),
  signals?: SelectionSignals,
): ResolveResult<T> & { explanation: ResolutionExplanation } {
  const stages: Stage[] = [];
  const explanation: ResolutionExplanation = {
    alias: sanitize(alias.key),
    strategy: alias.strategy,
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

  const known = eligible.map(({ candidate, detail }) => {
    detail.stage = "selection";
    return { candidate, detail };
  });
  // `minAge` is a prefilter, independent of the ranking: it runs before the
  // criteria and only on ages that can be evaluated, threshold inclusive
  // (now - released >= ms). Candidates without a reliable timestamp cannot be
  // aged and are dropped as missing metadata.
  const minAgeMs = alias.minAgeMs;
  let aged = known;
  let tooYoung = false;
  if (minAgeMs !== undefined) {
    aged = known.filter(({ candidate, detail }) => {
      const released = releasedMs(candidate);
      if (released === 0) {
        detail.reasons.push({
          code: "missing-metadata",
          message: "Missing or invalid time.released timestamp",
        });
        return false;
      }
      if (now - released >= minAgeMs) {
        detail.released = released;
        return true;
      }
      detail.released = released;
      tooYoung = true;
      detail.reasons.push({
        code: "min-age",
        message: `Released too recently (requires minAge>=${minAgeLabel(minAgeMs)})`,
      });
      return false;
    });
  }
  if (aged.length === 0) {
    // A selection count of 0 means no winner: no reliable timestamp, or none
    // of the dated candidates reached the minimum age.
    stages.push({ name: "selection", accepted: 0 });
    return tooYoung
      ? fail(
          "selection",
          "no-eligible",
          `no eligible candidate has reached the minimum age (minAge>=${minAgeLabel(minAgeMs ?? 0)})`,
        )
      : fail("selection", "missing-metadata", MISSING_POLICY_MESSAGE.latest);
  }

  // Lexicographic ranking by the ordered policy: each criterion narrows the
  // current tied group to its winners, and a criterion with missing metadata
  // only excludes those members from that group. A group reduced to one
  // candidate ends the ranking; the remaining criteria are never required.
  let group = aged;
  for (const strategy of alias.strategy) {
    const usable: Array<{ candidate: T; detail: CandidateExplanation; value: number }> = [];
    for (const member of group) {
      const value = criterionValue(strategy, member.candidate, signals);
      if (!value.usable) {
        member.detail.reasons.push({ ...MISSING_REASON[strategy] });
        continue;
      }
      if (strategy === "latest") member.detail.released = value.value;
      usable.push({ candidate: member.candidate, detail: member.detail, value: value.value });
    }
    if (usable.length === 0) {
      stages.push({ name: "selection", accepted: 0 });
      return fail("selection", "missing-metadata", MISSING_POLICY_MESSAGE[strategy]);
    }
    // Descending for latest/best (higher/newer wins), ascending for cheapest
    // (lower cost wins); equality keeps the criterion's tied peers together.
    const extreme =
      strategy === "cheapest"
        ? Math.min(...usable.map(({ value }) => value))
        : Math.max(...usable.map(({ value }) => value));
    const tied = usable.filter(({ value }) => value === extreme);
    if (tied.length < usable.length) {
      const winners = new Set(tied);
      for (const member of usable) {
        if (!winners.has(member)) {
          // Ranked but defeated by this criterion's ordering: still eligible.
          member.detail.outcome = "eligible";
          member.detail.reasons.push({ ...LOSS_REASON[strategy] });
        }
      }
    }
    group = tied;
    if (group.length === 1) break;
  }
  // One winner (plus its tied peers) survived every criterion it needed.
  stages.push({ name: "selection", accepted: 1 });

  // Final deterministic tie-break: model ID descending over the criterion-tied
  // group, always applied last and never skipped.
  const legacyLatest = alias.strategy.length === 1 && alias.strategy[0] === "latest";
  let winner: T;
  let winReason: { code: string; message: string };
  let loseReason: { code: string; message: string } | undefined;
  if (group.length > 1) {
    winner = group.reduce((a, b) => (b.candidate.id > a.candidate.id ? b : a)).candidate;
    winReason = legacyLatest
      ? { code: "id-tiebreak", message: "Newest release; won the descending model ID tie-break" }
      : {
          code: "id-tiebreak",
          message: "Tied under the ordered policy; won the descending model ID tie-break",
        };
    loseReason = legacyLatest
      ? {
          code: "id-tiebreak",
          message: "Same release timestamp; lost the descending model ID tie-break",
        }
      : {
          code: "id-tiebreak",
          message: "Tied under the ordered policy; lost the descending model ID tie-break",
        };
  } else {
    const first = group[0];
    if (!first) return fail("selection", "no-eligible", "selection produced no candidate");
    winner = first.candidate;
    winReason = legacyLatest
      ? {
          code: "newest-release",
          message: "Newest eligible candidate with a reliable release timestamp",
        }
      : { code: "selected", message: `Won the ordered policy (${alias.strategy.join(" > ")})` };
  }
  for (const { candidate, detail } of group) {
    detail.outcome = candidate === winner ? "selected" : "eligible";
    detail.reasons.push(
      candidate === winner ? winReason : (loseReason as { code: string; message: string }),
    );
  }
  explanation.winner = sanitize(canonical(winner));
  return { ok: true, model: winner, stages, explanation };
}
