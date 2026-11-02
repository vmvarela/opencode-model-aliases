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

  it("los requisitos de capabilities hacen perder al más reciente incompatible", () => {
    const cfg = alias({
      "anthropic/x": { match: "anthropic/**", filter: { capabilities: { tools: true } } },
    });
    const r = resolveLatest(
      [
        candidate({
          id: "new-no-tools",
          time: { released: 9_000 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        }),
        candidate({
          id: "old-with-tools",
          time: { released: 1_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("old-with-tools");

    // Exact equality: requiring tools=false rejects candidates with tools=true.
    const inverse = resolveLatest(
      [
        candidate({
          id: "with-tools",
          time: { released: 9_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        }),
        candidate({
          id: "without-tools",
          time: { released: 1_000 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
        }),
      ],
      alias({
        "anthropic/x": { match: "anthropic/**", filter: { capabilities: { tools: false } } },
      }),
    );
    expect(inverse.ok).toBe(true);
    if (inverse.ok) expect(inverse.model.id).toBe("without-tools");
  });

  it("filter.minContext exige limit.context >= umbral y descalifica al más reciente pequeño", () => {
    const cfg = alias({
      "anthropic/x": { match: "anthropic/**", filter: { minContext: 200_000 } },
    });
    const r = resolveLatest(
      [
        candidate({
          id: "new-small",
          time: { released: 9_000 },
          limit: { context: 128_000 },
        }),
        candidate({
          id: "old-large",
          time: { released: 1_000 },
          limit: { context: 1_000_000 },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("old-large");
  });

  it("input all-of aislado: al nuevo le falta una modalidad de entrada y gana el completo más antiguo", () => {
    const cfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: { capabilities: { input: ["text", "image"] } },
      },
    });

    // Todos los candidatos cumplen los demás checks configurados: solo difiere input.
    const r = resolveLatest(
      [
        candidate({
          id: "new-partial",
          time: { released: 9_000 },
          capabilities: { tools: true, input: ["text"], output: ["text", "reasoning"] },
        }),
        candidate({
          id: "old-complete",
          time: { released: 1_000 },
          capabilities: {
            tools: true,
            input: ["text", "image", "pdf"],
            output: ["text", "reasoning"],
          },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("old-complete");

    // Nadie lleva todas las modalidades de entrada: all-of los descarta.
    const none = resolveLatest(
      [
        candidate({
          id: "a",
          capabilities: { tools: true, input: ["text"], output: ["text", "reasoning"] },
        }),
      ],
      cfg,
    );
    expect(none.ok).toBe(false);
  });

  it("output all-of aislado: al nuevo le falta una modalidad de salida y gana el completo más antiguo", () => {
    const cfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: { capabilities: { output: ["text", "reasoning"] } },
      },
    });

    // Todos los candidatos cumplen los demás checks configurados: solo difiere output.
    const r = resolveLatest(
      [
        candidate({
          id: "new-partial",
          time: { released: 9_000 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        }),
        candidate({
          id: "old-complete",
          time: { released: 1_000 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text", "reasoning"] },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("old-complete");

    // Nadie lleva todas las modalidades de salida: all-of los descarta.
    const none = resolveLatest(
      [
        candidate({
          id: "a",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        }),
      ],
      cfg,
    );
    expect(none.ok).toBe(false);
  });

  it("filter.capabilities vacío declara ningún requisito: candidato sin capabilities es elegible", () => {
    const cfg = alias({
      "anthropic/x": { match: "anthropic/**", filter: { capabilities: {} } },
    });
    const r = resolveLatest([candidate({ id: "bare", time: { released: 1_000 } })], cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("bare");

    // With an empty capability object the only requirement is minContext.
    const mixed = alias({
      "anthropic/y": { match: "anthropic/**", filter: { capabilities: {}, minContext: 1 } },
    });
    const withContext = resolveLatest(
      [candidate({ id: "bare", time: { released: 1_000 }, limit: { context: 2 } })],
      mixed,
    );
    expect(withContext.ok).toBe(true);
    if (withContext.ok) expect(withContext.model.id).toBe("bare");
  });

  it("metadatos de capabilities o contexto ausentes fallan un requisito configurado", () => {
    const caps = alias({
      "anthropic/x": { match: "anthropic/**", filter: { capabilities: { tools: true } } },
    });
    const noCaps = resolveLatest([candidate({ id: "bare", time: { released: 1_000 } })], caps);
    expect(noCaps.ok).toBe(false);
    if (!noCaps.ok) expect(noCaps.failure.kind).toBe("no-eligible");

    const ctx = alias({ "anthropic/x": { match: "anthropic/**", filter: { minContext: 1 } } });
    const noLimit = resolveLatest([candidate({ id: "bare", time: { released: 1_000 } })], ctx);
    expect(noLimit.ok).toBe(false);
    if (!noLimit.ok) expect(noLimit.failure.kind).toBe("no-eligible");

    // Partial metadata (capabilities present, modality list missing) also fails.
    const modalities = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: { capabilities: { input: ["text"] } },
      },
    });
    const partial = resolveLatest(
      [candidate({ id: "partial", capabilities: { tools: true } })],
      modalities,
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.failure.kind).toBe("no-eligible");
  });

  it("sin requisitos configurados, candidatos sin capabilities/limit conservan el comportamiento", () => {
    const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const r = resolveLatest([candidate({ id: "bare", time: { released: 1_000 } })], cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.id).toBe("bare");
      expect(r.stages.map((s) => s.name)).toEqual(["matching", "filtering", "selection"]);
    }
  });

  it("los diagnósticos distinguen filtrado status/enabled de requisitos capability/contexto", () => {
    // Old diagnostic preserved: everyone dropped by enabled/status.
    const statusCfg = alias({ "anthropic/x": { match: "anthropic/**" } });
    const statusOnly = resolveLatest([candidate({ id: "off", enabled: false })], statusCfg);
    expect(statusOnly.ok).toBe(false);
    if (!statusOnly.ok) {
      expect(statusOnly.failure.kind).toBe("no-eligible");
      expect(statusOnly.failure.reason).toContain("enabled/status");
      expect(statusOnly.failure.reason).not.toContain("requirements");
    }

    // Capability/context diagnostic: enabled/status passed, requirements did not.
    const reqCfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: {
          capabilities: { tools: true, input: ["image"] },
          minContext: 128_000,
        },
      },
    });
    const req = resolveLatest(
      [
        candidate({
          id: "inadequate",
          time: { released: 1_000 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          limit: { context: 64_000 },
        }),
      ],
      reqCfg,
    );
    expect(req.ok).toBe(false);
    if (!req.ok) {
      expect(req.failure.kind).toBe("no-eligible");
      // Deterministic, actionable, threshold-bearing and free of ids/private data.
      expect(req.failure.reason).toBe(
        "no candidate satisfied all configured requirements " +
          "(unmet across the candidate set: capabilities.tools=true; " +
          "capabilities.input includes [image]; minContext>=128000)",
      );
      expect(req.failure.reason).not.toContain("inadequate");
      expect(req.failure.reason).not.toContain("anthropic");
    }

    // Stage count reflects the eligibility outcome (matching kept 1).
    const stageCfg = alias({
      "anthropic/x": { match: "anthropic/**", filter: { capabilities: { tools: true } } },
    });
    const dropped = resolveLatest(
      [candidate({ id: "a", capabilities: { tools: false } })],
      stageCfg,
    );
    expect(dropped.ok).toBe(false);
  });

  it("el diagnóstico aísla un único requisito incumplido aunque haya otros configurados", () => {
    const cfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          minContext: 1_000,
        },
      },
    });
    // El candidato cumple input, output y minContext: solo tools está incumplido.
    const r = resolveLatest(
      [
        candidate({
          id: "no-tools",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          limit: { context: 5_000 },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toContain("capabilities.tools=true");
      expect(r.failure.reason).not.toContain("capabilities.input");
      expect(r.failure.reason).not.toContain("capabilities.output");
      expect(r.failure.reason).not.toContain("minContext");
    }
  });

  it("un requisito minContext incumplido es el único listado en el diagnóstico", () => {
    const cfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          minContext: 200_000,
        },
      },
    });
    // El candidato cumple todos los checks de capabilities: solo minContext está incumplido.
    const r = resolveLatest(
      [
        candidate({
          id: "small",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 8_000 },
        }),
      ],
      cfg,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toContain("minContext>=200000");
      expect(r.failure.reason).not.toContain("capabilities");
    }
  });

  it("agrega y deduplica los requisitos incumplidos del conjunto, en orden fijo e independiente de la fuente", () => {
    const cfg = alias({
      "anthropic/x": {
        match: "anthropic/**",
        filter: {
          capabilities: { tools: true, input: ["text", "image"], output: ["text", "reasoning"] },
          minContext: 100_000,
        },
      },
    });
    // Un candidato incumple solo tools, el otro tools y minContext; ambos
    // cumplen los checks de input/output configurados, así que se omiten.
    const makeCandidates = () => [
      candidate({
        id: "a",
        time: { released: 1_000 },
        capabilities: { tools: false, input: ["text", "image"], output: ["text", "reasoning"] },
        limit: { context: 200_000 },
      }),
      candidate({
        id: "c",
        time: { released: 2_000 },
        capabilities: { tools: false, input: ["text", "image"], output: ["text", "reasoning"] },
        limit: { context: 10_000 },
      }),
    ];
    const expected =
      "no candidate satisfied all configured requirements " +
      "(unmet across the candidate set: capabilities.tools=true; minContext>=100000)";

    const first = resolveLatest(makeCandidates(), cfg);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.failure.reason).toBe(expected);

    // Invertir el orden del catálogo fuente produce exactamente la misma razón.
    const reversed = resolveLatest([...makeCandidates()].reverse(), cfg);
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.failure.reason).toBe(expected);
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
      strategy: ["latest"],
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

  describe("filter.minAge con reloj fijo", () => {
    const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
    const HOUR = 3_600_000;

    function ageAlias(minAge: string): NormalizedAlias {
      return alias({
        "anthropic/x": { match: "anthropic/**", filter: { minAge } },
      });
    }

    it("descarta al demasiado reciente y resuelve al siguiente más antiguo que cumple", () => {
      const cfg = ageAlias("48h");
      const r = resolveLatest(
        [
          candidate({ id: "fresh", time: { released: NOW - HOUR } }),
          candidate({ id: "settled", time: { released: NOW - 72 * HOUR } }),
        ],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("settled");

      if (r.ok) {
        const detail = r.explanation.candidates.find((entry) => entry.id === "anthropic/fresh");
        expect(detail?.stage).toBe("selection");
        expect(detail?.outcome).toBe("rejected");
        expect(detail?.reasons[0]).toMatchObject({
          code: "min-age",
          message: expect.stringContaining("minAge>=2d"),
        });
      }
    });

    it("el umbral es inclusivo: liberado exactamente minAge antes es elegible", () => {
      const cfg = ageAlias("48h");
      const r = resolveLatest(
        [candidate({ id: "exact", time: { released: NOW - 48 * HOUR } })],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("exact");
    });

    it("nadie cumple minAge: no-eligible en selection con razon sin ids", () => {
      const cfg = ageAlias("7d");
      const r = resolveLatest(
        [
          candidate({ id: "a", time: { released: NOW - HOUR } }),
          candidate({ id: "b", time: { released: NOW - 2 * HOUR } }),
        ],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("no-eligible");
        expect(r.failure.reason).toContain("minimum age");
        expect(r.failure.reason).toContain("minAge>=7d");
        // Non-sensitive: no candidate ids or providers.
        expect(r.failure.reason).not.toContain("anthropic");
      }

      // Everyone passed filtering (stage counts: matching kept 2, filtering kept 2).
      const explanation = r.explanation;
      expect(explanation.failure?.stage).toBe("selection");
      const byStage = new Map(explanation.stages.map((stage) => [stage.name, stage.accepted]));
      expect(byStage.get("matching")).toBe(2);
      expect(byStage.get("filtering")).toBe(2);
    });

    it("un minAge de dias se formatea como dias en el diagnostico", () => {
      const cfg = ageAlias("2d");
      const r = resolveLatest(
        [candidate({ id: "young", time: { released: NOW - HOUR } })],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.reason).toContain("minAge>=2d");
      const detail = r.explanation.candidates[0];
      expect(detail?.reasons[0]).toMatchObject({
        code: "min-age",
        message: expect.stringContaining("minAge>=2d"),
      });
    });

    it("timestamps ausentes o invalidos siguen rechazados aunque minAge este configurado", () => {
      const cfg = ageAlias("1h");
      const r = resolveLatest(
        [
          candidate({ id: "missing", time: { released: 0 } }),
          candidate({ id: "invalid", time: { released: Number.NaN } }),
        ],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("missing-metadata");
        expect(r.failure.reason).toContain("time.released");
      }
    });

    it("sin minAge la resolucion usa el now por defecto y no cambia", () => {
      const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
      const r = resolveLatest(
        [
          candidate({ id: "old", time: { released: NOW - 100 * HOUR } }),
          candidate({ id: "new", time: { released: NOW } }),
        ],
        cfg,
        NOW,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("new");
    });
  });

  describe("ordered selection policy", () => {
    /** Builds a signals map from a plain object keyed by canonical id. */
    const mapOf = (values: Record<string, number>): Map<string, number> =>
      new Map(Object.entries(values));

    it("best dominates release date; scalar best attaches the deterministic latest fallback", () => {
      for (const select of ["best" as const, ["best", "latest"] as const] as const) {
        const cfg = alias(
          select === "best"
            ? { "anthropic/x": { match: "anthropic/**", select: { strategy: "best" } } }
            : {
                "anthropic/x": {
                  match: "anthropic/**",
                  select: { strategy: ["best", "latest"] },
                },
              },
        );
        const r = resolveLatest(
          [
            candidate({ id: "new", time: { released: 9_000 } }),
            candidate({ id: "old", time: { released: 1_000 } }),
          ],
          cfg,
          0,
          { best: mapOf({ "anthropic/old": 9, "anthropic/new": 1 }) },
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.model.id).toBe("old");
      }
    });

    it("cheapest is ascending; scalar cheapest attaches the deterministic latest fallback", () => {
      for (const select of [
        { select: { strategy: "cheapest" as const } },
        { select: { strategy: ["cheapest", "latest"] as const } },
      ]) {
        const cfg = alias({ "anthropic/x": { match: "anthropic/**", ...select } });
        const r = resolveLatest(
          [
            candidate({ id: "cheap", time: { released: 1_000 } }),
            candidate({ id: "costly", time: { released: 9_000 } }),
          ],
          cfg,
          0,
          { cheapest: mapOf({ "anthropic/cheap": 1, "anthropic/costly": 9 }) },
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.model.id).toBe("cheap");
      }
    });

    it("ranking is lexicographic, never a weighted blend of criteria", () => {
      const cfg = alias({
        "anthropic/x": {
          match: "anthropic/**",
          select: { strategy: ["best", "cheapest", "latest"] },
        },
      });
      // new is massively cheaper and newer, but old has a strictly better
      // quality score: best wins outright and the rest is never consulted.
      const r = resolveLatest(
        [
          candidate({ id: "new", time: { released: 9_000 } }),
          candidate({ id: "old", time: { released: 1_000 } }),
        ],
        cfg,
        0,
        {
          best: mapOf({ "anthropic/old": 9, "anthropic/new": 8 }),
          cheapest: mapOf({ "anthropic/old": 10_000, "anthropic/new": 1 }),
        },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("old");
      if (r.ok) {
        const winner = r.explanation.candidates.find((c) => c.outcome === "selected");
        const loser = r.explanation.candidates.find((c) => c.outcome === "eligible");
        expect(winner?.reasons[0]).toMatchObject({ code: "selected" });
        expect(loser?.reasons[0]).toMatchObject({
          code: "lower-score",
          message: "Lower quality score than the selected candidate",
        });
      }
    });

    it("criterion order matters and every criterion only breaks its own ties", () => {
      // [cheapest, best]: the cheapest models are compared by score.
      const byCostFirst = resolveLatest(
        [
          candidate({ id: "a", time: { released: 3_000 } }),
          candidate({ id: "b", time: { released: 9_000 } }),
        ],
        alias({
          "anthropic/x": { match: "anthropic/**", select: { strategy: ["cheapest", "best"] } },
        }),
        0,
        {
          best: mapOf({ "anthropic/a": 1, "anthropic/b": 9 }),
          cheapest: mapOf({ "anthropic/a": 5, "anthropic/b": 5 }),
        },
      );
      expect(byCostFirst.ok).toBe(true);
      if (byCostFirst.ok) expect(byCostFirst.model.id).toBe("b");

      // [best, cheapest]: the best score wins regardless of cost.
      const byScoreFirst = resolveLatest(
        [
          candidate({ id: "a", time: { released: 3_000 } }),
          candidate({ id: "b", time: { released: 9_000 } }),
        ],
        alias({
          "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "cheapest"] } },
        }),
        0,
        {
          best: mapOf({ "anthropic/a": 1, "anthropic/b": 9 }),
          cheapest: mapOf({ "anthropic/a": 1, "anthropic/b": 9 }),
        },
      );
      expect(byScoreFirst.ok).toBe(true);
      if (byScoreFirst.ok) expect(byScoreFirst.model.id).toBe("b");

      // [best, latest]: equal scores fall through to the release date.
      const byLatestTie = resolveLatest(
        [
          candidate({ id: "a", time: { released: 1_000 } }),
          candidate({ id: "b", time: { released: 5_000 } }),
        ],
        alias({
          "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "latest"] } },
        }),
        0,
        { best: mapOf({ "anthropic/a": 7, "anthropic/b": 7 }) },
      );
      expect(byLatestTie.ok).toBe(true);
      if (byLatestTie.ok) expect(byLatestTie.model.id).toBe("b");
    });

    it("both sides of a criterion-tied ID tie-break are explained deterministically", () => {
      // Explicit ["cheapest"]: no latest fallback, so a cost tie reaches the
      // final model-ID tie-break.
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["cheapest"] } },
      });
      const run = () =>
        resolveLatest(
          [
            candidate({ id: "a", time: { released: 9_000 } }),
            candidate({ id: "z", time: { released: 1_000 } }),
          ],
          cfg,
          0,
          { cheapest: mapOf({ "anthropic/a": 4, "anthropic/z": 4 }) },
        );
      const withOrder = (candidates: Candidate[]) =>
        resolveLatest(candidates, cfg, 0, {
          cheapest: mapOf({ "anthropic/a": 4, "anthropic/z": 4 }),
        });
      const r = run();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.model.id).toBe("z");
        const codes = r.explanation.candidates.map((c) => c.reasons.map((x) => x.code));
        expect(codes).toEqual([["id-tiebreak"], ["id-tiebreak"]]);
        const winner = r.explanation.candidates.find((c) => c.outcome === "selected");
        const loser = r.explanation.candidates.find((c) => c.outcome === "eligible");
        expect(loser?.reasons[0]?.message).toBe(
          "Tied under the ordered policy; lost the descending model ID tie-break",
        );
        expect(loser?.reasons.length).toBe(1);
        expect(winner?.reasons[0]?.message).toBe(
          "Tied under the ordered policy; won the descending model ID tie-break",
        );
      }
      // Reversed input order produces the identical deterministic resolution.
      const reversed = withOrder([
        candidate({ id: "z", time: { released: 1_000 } }),
        candidate({ id: "a", time: { released: 9_000 } }),
      ]);
      expect(reversed.ok && reversed.model.id).toBe(r.ok ? r.model.id : undefined);
      if (r.ok && reversed.ok) expect(reversed.explanation).toEqual(r.explanation);
    });

    it("a criterion is still required for the tied group: eliminated richer candidates are not resurrected", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["latest", "best"] } },
      });
      // Two newest candidates tie on latest and both lack a rating; the older
      // candidate has a valid best rating, but latest eliminated it before
      // best was ever reached — best must still fail the alias.
      const r = resolveLatest(
        [
          candidate({ id: "older", time: { released: 1_000 } }),
          candidate({ id: "a", time: { released: 5_000 } }),
          candidate({ id: "b", time: { released: 5_000 } }),
        ],
        cfg,
        0,
        { best: mapOf({ "anthropic/older": 9 }) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("missing-metadata");
        expect(r.failure.reason).toBe(
          "no eligible candidate has usable quality score (best) metadata",
        );
        expect(r.explanation.failure).toMatchObject({ stage: "selection" });
      }
      // The eliminated older candidate is not resurrected and its rating was
      // not consulted as a fallback for the tie group.
      const older = r.explanation.candidates.find((c) => c.id === "anthropic/older");
      expect(older?.outcome).toBe("eligible");
      expect(older?.reasons[0]).toMatchObject({
        code: "older-release",
        message: "Older release than the selected candidate",
      });
      expect(older?.released).toBe(1_000);
    });

    it("unusable values are NaN, Infinity and absent signal entries alike", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "latest"] } },
      });
      const r = resolveLatest(
        [
          candidate({ id: "inf", time: { released: 5_000 } }),
          candidate({ id: "valid", time: { released: 1_000 } }),
        ],
        cfg,
        0,
        { best: mapOf({ "anthropic/inf": Number.POSITIVE_INFINITY, "anthropic/valid": 2 }) },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("valid");
      const detail = r.explanation.candidates.find((c) => c.id === "anthropic/inf");
      expect(detail?.outcome).toBe("rejected");
      expect(detail?.reasons[0]).toMatchObject({
        code: "missing-metadata",
        message: "Missing or invalid quality score (best) metadata",
      });
    });

    it("missing values only exclude from the current tied group and never win", () => {
      const cfg = alias({
        "anthropic/x": {
          match: "anthropic/**",
          select: { strategy: ["cheapest", "best", "latest"] },
        },
      });
      // "miss" has top release date and-best-way score, but no cost signal:
      // it is excluded at cheapest and can never come back later.
      const r = resolveLatest(
        [
          candidate({ id: "miss", time: { released: 9_000 } }),
          candidate({ id: "priced", time: { released: 1_000 } }),
        ],
        cfg,
        0,
        {
          cheapest: mapOf({ "anthropic/priced": 3 }),
          best: mapOf({ "anthropic/miss": 99, "anthropic/priced": 1 }),
        },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("priced");
      const miss = r.explanation.candidates.find((c) => c.id === "anthropic/miss");
      expect(miss?.outcome).toBe("rejected");
      expect(miss?.reasons[0]).toMatchObject({
        code: "missing-metadata",
        message: "Missing or invalid comparison cost (cheapest) metadata",
      });
      const priced = r.explanation.candidates.find((c) => c.id === "anthropic/priced");
      expect(priced?.outcome).toBe("selected");
    });

    it("no tied member usable at a criterion leaves the alias unresolved without skipping it", () => {
      // [best, latest]: everyone lacks best data; the alias must not silently
      // fall through to latest even though dated candidates exist.
      const bestFirst = resolveLatest(
        [
          candidate({ id: "a", time: { released: 9_000 } }),
          candidate({ id: "b", time: { released: 2_000 } }),
        ],
        alias({
          "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "latest"] } },
        }),
        0,
      );
      expect(bestFirst.ok).toBe(false);
      if (!bestFirst.ok) {
        expect(bestFirst.failure.kind).toBe("missing-metadata");
        expect(bestFirst.failure.reason).toBe(
          "no eligible candidate has usable quality score (best) metadata",
        );
      }
      // Ordered the other way, latest does the work and succeeds.
      const latestFirst = resolveLatest(
        [
          candidate({ id: "a", time: { released: 9_000 } }),
          candidate({ id: "b", time: { released: 2_000 } }),
        ],
        alias({
          "anthropic/x": { match: "anthropic/**", select: { strategy: ["latest", "best"] } },
        }),
        0,
      );
      expect(latestFirst.ok).toBe(true);
      if (latestFirst.ok) expect(latestFirst.model.id).toBe("a");
    });

    it("once one winner remains the later criteria are not required", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "latest"] } },
      });
      // Two best-tied candidates; only "a" has a best signal, and it has no
      // release date at all: best decides outright and latest is never asked.
      const r = resolveLatest([candidate({ id: "a", time: { released: 0 } })], cfg, 0, {
        best: mapOf({ "anthropic/a": 7 }),
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("a");
    });

    it("an undated candidate can still win under a policy that never evaluates latest", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["cheapest"] } },
      });
      const r = resolveLatest(
        [
          candidate({ id: "undated", time: { released: Number.NaN } }),
          candidate({ id: "dated", time: { released: 1 } }),
        ],
        cfg,
        0,
        { cheapest: mapOf({ "anthropic/undated": 1, "anthropic/dated": 2 }) },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("undated");
    });

    it("minAge is a prefilter independent of the policy; undated candidates cannot be aged", () => {
      const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
      const HOUR = 3_600_000;
      const cfg = alias({
        "anthropic/x": {
          match: "anthropic/**",
          select: { strategy: ["cheapest"] },
          filter: { minAge: "48h" },
        },
      });
      // The cheaper model is undated: minAge cannot evaluate it, so even
      // without latest in the policy it is dropped as missing metadata.
      const r = resolveLatest(
        [
          candidate({ id: "cheap", time: { released: 0 } }),
          candidate({ id: "settled", time: { released: NOW - 72 * HOUR } }),
        ],
        cfg,
        NOW,
        { cheapest: mapOf({ "anthropic/cheap": 1, "anthropic/settled": 2 }) },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("settled");
      const cheap = r.explanation.candidates.find((c) => c.id === "anthropic/cheap");
      expect(cheap?.reasons[0]).toMatchObject({
        code: "missing-metadata",
        message: "Missing or invalid time.released timestamp",
      });

      // A priced but too-young candidate is dropped by the age prefilter.
      const young = resolveLatest(
        [
          candidate({ id: "fresh", time: { released: NOW - HOUR } }),
          candidate({ id: "settled", time: { released: NOW - 72 * HOUR } }),
        ],
        cfg,
        NOW,
        { cheapest: mapOf({ "anthropic/fresh": 1, "anthropic/settled": 99_999 }) },
      );
      expect(young.ok).toBe(true);
      if (young.ok) expect(young.model.id).toBe("settled");
      const fresh = young.explanation.candidates.find((c) => c.id === "anthropic/fresh");
      expect(fresh?.reasons[0]).toMatchObject({ code: "min-age" });
    });

    it("exposes the ordered policy through stage counts and explanation", () => {
      const cfg = alias({
        "anthropic/x": {
          match: "anthropic/**",
          select: { strategy: ["best", "cheapest", "latest"] },
        },
      });
      const r = resolveLatest([candidate({ id: "only", time: { released: 5 } })], cfg, 0, {
        best: mapOf({ "anthropic/only": 5 }),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.stages.map((stage) => stage.name)).toEqual(["matching", "filtering", "selection"]);
      expect(r.stages.map((stage) => stage.accepted)).toEqual([1, 1, 1]);
      expect(r.explanation.strategy).toEqual(["best", "cheapest", "latest"]);
      expect(r.explanation.winner).toBe("anthropic/only");
      const winner = r.explanation.candidates.find((c) => c.id === "anthropic/only");
      expect(winner?.reasons[0]).toMatchObject({
        code: "selected",
        message: "Won the ordered policy (best > cheapest > latest)",
      });
      // best decided outright: latest was never evaluated, so no released
      // value was needed for the diagnosis.
      expect(winner?.released).toBeUndefined();
    });

    it("evaluates the remaining criteria in a tie carry-over and stamps released usage", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["cheapest", "latest"] } },
      });
      const r = resolveLatest(
        [
          candidate({ id: "a", time: { released: 100 } }),
          candidate({ id: "b", time: { released: 200 } }),
        ],
        cfg,
        0,
        { cheapest: mapOf({ "anthropic/a": 4, "anthropic/b": 4 }) },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.model.id).toBe("b");
        const winner = r.explanation.candidates.find((c) => c.id === "anthropic/b");
        expect(winner?.released).toBe(200);
        const loser = r.explanation.candidates.find((c) => c.id === "anthropic/a");
        expect(loser?.reasons[0]).toMatchObject({
          code: "older-release",
          message: "Older release than the selected candidate",
        });
      }
    });

    it("latest policies ignore injected signals entirely and never leak them", () => {
      const cfg = alias({ "anthropic/x": { match: "anthropic/**" } });
      const input = [candidate({ id: "keep", time: { released: 2 } })];
      const snapshot = structuredClone(input);
      const r = resolveLatest(input, cfg, 0, {
        best: mapOf({ "anthropic/keep": 1 }),
        cheapest: mapOf({ "anthropic/keep": 1 }),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.model).toBe(input[0]);
        expect(input).toEqual(snapshot);
        const serialized = JSON.stringify(r.explanation);
        expect(serialized).not.toContain("best");
        expect(serialized).not.toContain("cheapest");
        expect(serialized).not.toContain("signal");
      }
    });

    it("does not mutate the input candidates or their ordering with signals", () => {
      const cfg = alias({ "anthropic/x": { match: "anthropic/**", select: { strategy: "best" } } });
      const input = [
        candidate({ id: "b", time: { released: 2 } }),
        candidate({ id: "a", time: { released: 3 } }),
      ];
      const snapshot = structuredClone(input);
      const r = resolveLatest(input, cfg, 0, {
        best: mapOf({ "anthropic/b": 9, "anthropic/a": 1 }),
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.id).toBe("b");
      expect(input).toEqual(snapshot);
      expect([...input].map((m) => m.id)).toEqual(["b", "a"]);
      // Returns the same object, never a clone or a derived shape.
      if (r.ok) expect(r.model).toBe(input[0]);
    });

    it("never invents a criterion value that no signal or metadata provides", () => {
      const cfg = alias({
        "anthropic/x": { match: "anthropic/**", select: { strategy: ["best", "latest"] } },
      });
      const r = resolveLatest(
        [
          candidate({ id: "scoreless", time: { released: 9_000 } }),
          candidate({ id: "scored", time: { released: 1_000 } }),
        ],
        cfg,
        0,
      );
      // Without best signals nobody is comparable on best: unresolved, and
      // the running candidate is never promoted.
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("missing-metadata");
    });
  });
});
