import { isPlainObject } from "./config.js";
import { sanitize } from "./report.js";
import type { Stage } from "./resolve.js";

export interface ExplanationReason {
  code: string;
  message: string;
}

export interface CandidateExplanation {
  id: string;
  matchedPatterns: string[];
  stage: Stage["name"];
  outcome: "selected" | "eligible" | "rejected";
  reasons: ExplanationReason[];
  released?: number;
}

/** Public, primitive-only snapshot of the decisions made by one resolver run. */
export interface ResolutionExplanation {
  alias: string;
  strategy: "latest";
  stages: Stage[];
  unmatched: number;
  candidates: CandidateExplanation[];
  winner?: string;
  failure?: ExplanationReason & { stage: Stage["name"] };
}

export type ExplainResponse =
  | { status: "active" | "inactive" | "unresolved"; explanation: ResolutionExplanation }
  | { status: "unknown-alias" }
  | { status: "unavailable" };

function isStage(value: unknown): value is Stage["name"] {
  return value === "matching" || value === "filtering" || value === "selection";
}
function reason(value: unknown): value is ExplanationReason {
  return (
    isPlainObject(value) && typeof value.code === "string" && typeof value.message === "string"
  );
}
function count(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validate the transport before rendering; the UI never evaluates selection rules. */
export function isExplainResponse(value: unknown): value is ExplainResponse {
  if (!isPlainObject(value)) return false;
  if (value.status === "unknown-alias" || value.status === "unavailable") return true;
  if (value.status !== "active" && value.status !== "inactive" && value.status !== "unresolved")
    return false;
  const report = value.explanation;
  if (
    !isPlainObject(report) ||
    typeof report.alias !== "string" ||
    report.strategy !== "latest" ||
    !count(report.unmatched) ||
    !Array.isArray(report.stages) ||
    !Array.isArray(report.candidates)
  )
    return false;
  if (report.winner !== undefined && typeof report.winner !== "string") return false;
  if (
    report.failure !== undefined &&
    (!isPlainObject(report.failure) || !reason(report.failure) || !isStage(report.failure.stage))
  )
    return false;
  if (
    value.status === "unresolved"
      ? report.failure === undefined || report.winner !== undefined
      : report.winner === undefined || report.failure !== undefined
  )
    return false;
  return (
    report.stages.every(
      (stage) => isPlainObject(stage) && isStage(stage.name) && count(stage.accepted),
    ) &&
    report.candidates.every(
      (candidate) =>
        isPlainObject(candidate) &&
        typeof candidate.id === "string" &&
        Array.isArray(candidate.matchedPatterns) &&
        candidate.matchedPatterns.every((pattern) => typeof pattern === "string") &&
        isStage(candidate.stage) &&
        (candidate.outcome === "selected" ||
          candidate.outcome === "eligible" ||
          candidate.outcome === "rejected") &&
        Array.isArray(candidate.reasons) &&
        candidate.reasons.every(reason) &&
        (candidate.released === undefined ||
          (typeof candidate.released === "number" &&
            Number.isFinite(candidate.released) &&
            candidate.released > 0)),
    )
  );
}

export function formatExplanation(response: ExplainResponse): string {
  if (response.status === "unknown-alias")
    return "Unknown alias. Use /model-aliases to view configured aliases.";
  if (response.status === "unavailable")
    return "Model alias explanation is unavailable: the current mapping could not be confirmed.";
  const report = response.explanation;
  const lines = [
    `Alias: ${sanitize(report.alias)}`,
    `Strategy: ${report.strategy}`,
    `Status: ${response.status}`,
  ];
  lines.push(report.stages.map((stage) => `${stage.name}: ${stage.accepted}`).join(" → "));
  if (report.failure)
    lines.push(`Failed at ${report.failure.stage}: ${sanitize(report.failure.message)}`);
  for (const candidate of report.candidates) {
    const marker =
      candidate.outcome === "selected" ? "✓" : candidate.outcome === "rejected" ? "✗" : "·";
    lines.push(
      "",
      `${marker} ${sanitize(candidate.id)} (${candidate.outcome})`,
      `  matched: ${candidate.matchedPatterns.map(sanitize).join(", ")}`,
    );
    if (candidate.stage === "selection")
      lines.push("  passed enabled/status and configured requirement filters");
    if (candidate.outcome === "rejected") lines.push(`  rejected at: ${candidate.stage}`);
    if (candidate.released !== undefined) {
      const date = new Date(candidate.released);
      lines.push(
        `  released: ${Number.isFinite(date.getTime()) ? date.toISOString() : candidate.released}`,
      );
    }
    for (const reason of candidate.reasons) lines.push(`  ${sanitize(reason.message)}`);
  }
  lines.push(
    "",
    `Other catalog models: ${report.unmatched} did not match the alias provider/include patterns.`,
  );
  return lines.join("\n");
}
