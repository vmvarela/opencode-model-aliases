import { describe, expect, it } from "vitest";
import type { AliasConfig, Candidate } from "../src/config.js";
import {
  formatCandidateDetail,
  formatExplanation,
  formatExplanationOverview,
  isExplainResponse,
} from "../src/explain.js";
import { normalizeOptions } from "../src/normalize.js";
import { resolveLatest } from "../src/resolve.js";

function model(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    providerID: "p",
    enabled: true,
    status: "active",
    time: { released: 1000 },
    ...overrides,
  };
}
function resolve(models: Candidate[], options: Partial<AliasConfig> = {}) {
  const normalized = normalizeOptions({ aliases: { "p/alias": { match: "p/m*", ...options } } });
  if (!normalized.ok || !normalized.config.aliases[0]) throw new Error("Invalid fixture");
  return resolveLatest(models, normalized.config.aliases[0]);
}

describe("resolution explanation", () => {
  it("records matching, exclusions, ranking and aggregate non-matches deterministically", () => {
    const models = [
      model("m-old"),
      model("m-new", { time: { released: 2000 } }),
      model("m-excluded"),
      model("unrelated"),
      model("m-foreign", { providerID: "q" }),
    ];
    const result = resolve(models, { exclude: "p/m-excluded" });
    expect(result.ok && result.model.id).toBe("m-new");
    expect(result.explanation).toEqual(
      resolve([...models].reverse(), { exclude: "p/m-excluded" }).explanation,
    );
    expect(result.explanation.unmatched).toBe(2);
    expect(result.explanation.candidates.map((c) => [c.id, c.outcome, c.reasons[0]?.code])).toEqual(
      [
        ["p/m-excluded", "rejected", "excluded-pattern"],
        ["p/m-new", "selected", "newest-release"],
        ["p/m-old", "eligible", "older-release"],
      ],
    );
    expect(result.explanation.candidates.every((c) => c.matchedPatterns[0] === "p/m*")).toBe(true);
  });

  it("explains both sides of a model ID tie-break", () => {
    const result = resolve([model("m-a"), model("m-z")]);
    expect(result.explanation.winner).toBe("p/m-z");
    expect(result.explanation.candidates.map((c) => c.reasons[0]?.code)).toEqual([
      "id-tiebreak",
      "id-tiebreak",
    ]);
  });

  it("records the failed stage for empty, unmatched, filtered and undated catalogs", () => {
    for (const [models, stage, code] of [
      [[], "matching", "no-candidates"],
      [[model("other")], "matching", "no-eligible"],
      [[model("m-off", { enabled: false })], "filtering", "no-eligible"],
      [[model("m-beta", { status: "beta" })], "filtering", "no-eligible"],
      [[model("m-undated", { time: { released: Number.NaN } })], "selection", "missing-metadata"],
    ] as const) {
      const result = resolve([...models]);
      expect(result.ok).toBe(false);
      expect(result.explanation.failure).toMatchObject({ stage, code });
      expect(result.explanation.stages.at(-1)).toEqual({ name: stage, accepted: 0 });
      expect(isExplainResponse({ status: "unresolved", explanation: result.explanation })).toBe(
        true,
      );
    }
  });

  it("distinguishes missing metadata from incompatible requirements and preserves reason order", () => {
    const result = resolve(
      [
        model("m-absent"),
        model("m-wrong", {
          capabilities: { tools: false, input: [], output: [] },
          limit: { context: 10 },
        }),
      ],
      {
        filter: {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          minContext: 100,
        },
      },
    );
    const [absent, wrong] = result.explanation.candidates;
    expect(absent?.reasons.map((r) => r.code)).toEqual(Array(4).fill("missing-metadata"));
    expect(wrong?.reasons.map((r) => r.code)).toEqual(Array(4).fill("requirement-not-met"));
    expect(wrong?.reasons.map((r) => r.message)).toEqual([
      "Does not satisfy capabilities.tools=true",
      "Does not satisfy capabilities.input includes [text]",
      "Does not satisfy capabilities.output includes [text]",
      "Does not satisfy minContext>=100",
    ]);
    expect(resolve([model("m-absent")]).ok).toBe(true);
  });

  it("never serializes opaque metadata and escapes terminal control characters", () => {
    const source = {
      ...model("m-\u001b[31m"),
      headers: { Authorization: "SECRET" },
      settings: { apiKey: "SECRET" },
    };
    const result = resolve([source]);
    const serialized = JSON.stringify(result.explanation);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("headers");
    const response = { status: "active" as const, explanation: result.explanation };
    expect(isExplainResponse(response)).toBe(true);
    expect(formatExplanation(response)).not.toContain("\u001b");
  });

  it("rejects malformed RPC data and renders unavailable and unknown aliases", () => {
    for (const value of [
      null,
      {},
      { status: "active" },
      { status: "active", explanation: { stages: [] } },
    ]) {
      expect(isExplainResponse(value)).toBe(false);
    }
    const valid = { status: "active", explanation: resolve([model("m-a")]).explanation };
    for (const released of [0, -1, Number.NaN, "date"]) {
      const invalid = structuredClone(valid);
      Object.assign(invalid.explanation.candidates[0] ?? {}, { released });
      expect(isExplainResponse(invalid)).toBe(false);
    }
    expect(formatExplanation({ status: "unknown-alias" })).toContain("Unknown alias");
    expect(formatExplanation({ status: "unavailable" })).toContain("unavailable");
  });

  it("formats candidate details and overview with sanitized fields and stage indicators", () => {
    const result = resolve([model("m-a"), model("m-b", { enabled: false })]);
    const response = { status: "active" as const, explanation: result.explanation };
    const overview = formatExplanationOverview(response);
    expect(overview).toContain("Alias: p/alias");
    expect(overview).toContain("Strategy: latest");
    expect(overview).toContain("Status: active");
    expect(overview).toContain("Winner: p/m-a");
    expect(overview).toContain("Candidates: 2");

    const [winner, rejected] = result.explanation.candidates;
    expect(winner).toBeDefined();
    expect(rejected).toBeDefined();
    if (winner && rejected) {
      const winnerDetail = formatCandidateDetail(winner);
      expect(winnerDetail).toContain("✓ p/m-a (selected)");
      expect(winnerDetail).toContain("passed enabled/status and configured requirement filters");

      const rejectedDetail = formatCandidateDetail(rejected);
      expect(rejectedDetail).toContain("✗ p/m-b (rejected)");
      expect(rejectedDetail).toContain("rejected at: filtering");
      expect(rejectedDetail).toContain("Model is disabled");
    }
  });
});

it("rejects coerced enum values and incomplete resolution outcomes", () => {
  const explanation = resolve([model("m-a")]).explanation;
  expect(isExplainResponse({ status: ["active"], explanation })).toBe(false);
  const stages = structuredClone(explanation);
  Object.assign(stages.stages[0] ?? {}, { name: ["matching"] });
  expect(isExplainResponse({ status: "active", explanation: stages })).toBe(false);
  const candidates = structuredClone(explanation);
  Object.assign(candidates.candidates[0] ?? {}, { outcome: ["selected"] });
  expect(isExplainResponse({ status: "active", explanation: candidates })).toBe(false);
  const noWinner = structuredClone(explanation);
  delete noWinner.winner;
  expect(isExplainResponse({ status: "active", explanation: noWinner })).toBe(false);
  expect(isExplainResponse({ status: "unresolved", explanation })).toBe(false);
});
