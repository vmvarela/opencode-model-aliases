import { describe, expect, it } from "vitest";
import type { Candidate, NormalizedAlias, Options } from "../src/index.js";
import { normalizeOptions, resolveLatest } from "../src/index.js";

/** Minimal candidate conforming to Candidate with convenient overrides. */
function candidate(overrides: Partial<Candidate> & { id: string; providerID?: string }): Candidate {
  return {
    providerID: overrides.providerID ?? "anthropic",
    enabled: true,
    status: "active",
    time: { released: 0 },
    ...overrides,
  };
}

/** Normalizes options and returns the first alias (or throws the failure as an error). */
function alias(raw: Record<string, unknown>): NormalizedAlias {
  const r = normalizeOptions({ aliases: raw } as unknown as Options);
  if (!r.ok) throw new Error(`normalize failed: ${r.failure.reason}`);
  const first = r.config.aliases[0];
  if (!first) throw new Error("missing alias");
  return first;
}

describe("resolveLatest", () => {
  it("resuelve el candidato elegible más reciente por timestamp descendente", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const r = resolveLatest(
      [
        candidate({ id: "old", time: { released: 1_000 } }),
        candidate({ id: "new", time: { released: 2_000 } }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("new");
  });

  it("el orden temporal domina al léxico; los empates exactos caen a id descendente", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const ts = 5_000;

    // Same timestamp: by code units, zeta > beta, descending.
    const ties = resolveLatest(
      [
        candidate({ id: "beta", time: { released: ts } }),
        candidate({ id: "zeta", time: { released: ts } }),
      ],
      cfg,
    );
    expect(ties.ok).toBe(true);
    if (ties.ok) expect(ties.model.id).toBe("zeta");

    // A more recent timestamp wins even when the id sorts earlier lexically.
    const order = resolveLatest(
      [
        candidate({ id: "zeta", time: { released: ts } }),
        candidate({ id: "aaa", time: { released: ts + 1 } }),
      ],
      cfg,
    );
    expect(order.ok).toBe(true);
    if (order.ok) expect(order.model.id).toBe("aaa");
  });

  it("distingue fuente vacía, sin matching, filtrados y fechas ausentes", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });

    const empty = resolveLatest([], cfg);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.failure.kind).toBe("no-candidates");

    const unmatched = resolveLatest([candidate({ id: "gpt-x", providerID: "openai" })], cfg);
    expect(unmatched.ok).toBe(false);
    if (!unmatched.ok) expect(unmatched.failure.kind).toBe("no-eligible");

    const disabled = resolveLatest([candidate({ id: "claude-a", enabled: false })], cfg);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.failure.kind).toBe("no-eligible");

    const wrongStatus = resolveLatest([candidate({ id: "claude-a", status: "deprecated" })], cfg);
    expect(wrongStatus.ok).toBe(false);
    if (!wrongStatus.ok) expect(wrongStatus.failure.kind).toBe("no-eligible");

    const unknownDates = resolveLatest([candidate({ id: "b" }), candidate({ id: "c" })], cfg);
    expect(unknownDates.ok).toBe(false);
    if (!unknownDates.ok) expect(unknownDates.failure.kind).toBe("missing-metadata");
  });

  it("las fechas desconocidas nunca ganan; fechas inválidas se tratan como desconocidas", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const r = resolveLatest(
      [
        candidate({ id: "unknown-lexical-last", time: { released: 0 } }),
        candidate({ id: "known", time: { released: 1 } }),
        candidate({ id: "invalid", time: { released: Number.NaN } }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("known");
  });

  it("el filtro es por alias: el override admite alpha pero nunca deprecated", () => {
    const cfg = alias({
      "anthropic/x": { match: "anthropic/**", filter: { status: ["active", "alpha"] } },
    });
    const r = resolveLatest(
      [
        candidate({ id: "alpha-one", status: "alpha", time: { released: 300 } }),
        candidate({ id: "old-active", time: { released: 100 } }),
        candidate({ id: "deprecated-one", status: "deprecated", time: { released: 500 } }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("alpha-one");

    // A deprecated newer than everything else stays filtered.
    const withDep = resolveLatest(
      [candidate({ id: "dep", status: "deprecated", time: { released: 9_999 } })],
      cfg,
    );
    expect(withDep.ok).toBe(false);
    if (!withDep.ok) expect(withDep.failure.kind).toBe("no-eligible");
  });

  it("los exclude eliminan por id canónico; los ids pueden contener '/'", () => {
    const cfg = alias({
      "anthropic/suite": { match: "anthropic/**", exclude: ["anthropic/claude-a"] },
    });
    const r = resolveLatest(
      [
        candidate({ id: "claude-a" }),
        candidate({ id: "claude-b" }),
        candidate({ id: "suite/sub/nightly", time: { released: 10 } }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("suite/sub/nightly");
  });

  it("no muta ni reordena la entrada; sin efectos secundarios", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const input = [
      candidate({ id: "b", time: { released: 2 } }),
      candidate({ id: "a", time: { released: 3 } }),
    ];
    const snapshot = structuredClone(input);
    const r = resolveLatest(input, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("a");
    expect(input).toEqual(snapshot);
    expect([...input].map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("la igualdad de proveedor se comprueba independientemente de los matchers", () => {
    // Deliberately permissive matcher: only the providerID defense must
    // prevent a candidate from another provider from winning.
    const permissive: NormalizedAlias = {
      key: "anthropic/x",
      provider: "anthropic",
      modelID: "x",
      match: [],
      exclude: [],
      includes: [() => true],
      excludes: [],
      statuses: ["active"],
      name: "anthropic/x",
      nameExplicit: false,
    };
    const r = resolveLatest(
      [
        candidate({ id: "foreign", providerID: "openai", time: { released: 9_999 } }),
        candidate({ id: "own", time: { released: 1 } }),
      ],
      permissive,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("own");

    const onlyForeign = resolveLatest(
      [candidate({ id: "foreign", providerID: "openai", time: { released: 9_999 } })],
      permissive,
    );
    expect(onlyForeign.ok).toBe(false);
    if (!onlyForeign.ok) expect(onlyForeign.failure.kind).toBe("no-eligible");
  });

  it("expone conteos por etapa para diagnóstico", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const r = resolveLatest(
      [
        candidate({ id: "in", time: { released: 2 } }),
        candidate({ id: "out", providerID: "openai" }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stages.map((s) => s.name)).toEqual(["matching", "filtering", "selection"]);
      expect(r.stages[0]).toEqual({ name: "matching", accepted: 1 });
      expect(r.stages[1]).toEqual({ name: "filtering", accepted: 1 });
    }
  });
});
