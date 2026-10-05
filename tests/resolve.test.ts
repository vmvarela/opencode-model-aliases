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
