import { describe, expect, it } from "vitest";
import type { Options } from "../src/index.js";
import { normalizeOptions, splitSelector } from "../src/index.js";

/** Builds Options with deliberately invalid values in the tests. */
function optionsWith(
  aliases: Record<string, unknown>,
  extra: Partial<Options> = {},
): Record<string, unknown> {
  return { aliases, ...extra };
}

function normalize(raw: unknown) {
  return normalizeOptions(raw as Options);
}

const okOptions = () => optionsWith({ "anthropic/claude": { match: "anthropic/**" } });

describe("normalizeOptions", () => {
  it("aliases es obligatorio; {} es válido y strict/debug por defecto false", () => {
    expect(normalize({}).ok).toBe(false);
    expect(normalize({ aliases: "x" }).ok).toBe(false);
    expect(normalize({ aliases: null }).ok).toBe(false);
    expect(normalize({ aliases: [] }).ok).toBe(false);

    const ok = normalize({ aliases: {} });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.aliases).toEqual([]);
      expect(ok.config.strict).toBe(false);
      expect(ok.config.debug).toBe(false);
    }
  });

  it("normaliza cada alias con su matcher, filtro y nombre", () => {
    const r = normalize(
      optionsWith({
        "anthropic/claude": {
          match: ["anthropic/claude-*"],
          exclude: "anthropic/claude-2*",
          filter: { status: ["active", "alpha"] },
          select: { strategy: "latest" },
          name: "Claude",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.aliases).toHaveLength(1);
      const alias = r.config.aliases[0];
      if (!alias) throw new Error("missing alias");
      expect(alias.key).toBe("anthropic/claude");
      expect(alias.provider).toBe("anthropic");
      expect(alias.match).toEqual(["anthropic/claude-*"]);
      expect(alias.exclude).toEqual(["anthropic/claude-2*"]);
      expect(alias.statuses).toEqual(["active", "alpha"]);
      expect(alias.name).toBe("Claude");
      expect(alias.modelID).toBe("claude");
      expect(alias.nameExplicit).toBe(true);
      expect(alias.includes).toHaveLength(1);
      expect(alias.excludes).toHaveLength(1);
    }
  });

  it("splitSelector parte en el primer '/' y conserva los '/' internos del modelo", () => {
    expect(splitSelector("anthropic/claude-3/nightly")).toEqual({
      provider: "anthropic",
      modelID: "claude-3/nightly",
    });
    for (const bad of ["novendor", "/leading", "trailing/"]) {
      const s = splitSelector(bad);
      expect("kind" in s && s.kind).toBe("parse-error");
    }
  });

  it("rechaza claves de alias malformadas o con '#'", () => {
    for (const key of ["novendor", "/leading", "trailing/", "x/a#b", "#x"]) {
      const r = normalize(optionsWith({ [key]: { match: "x/**" } }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("parse-error");
        expect(r.failure.reason).toContain('alias "');
      }
    }
  });

  it("rechaza proveedores extglob/glob/escape en claves de alias", () => {
    for (const key of [
      "(anthropic)/claude",
      "@(anthropic)/claude",
      "!(anthropic)/claude",
      "?(anthropic)/claude",
      "anthropic?/claude",
      "{anthropic,openai}/claude",
      "[anthropic]/claude",
      "anthropic\\b/claude",
      "anthropic|openai/claude",
      "anthropic+more/claude",
    ]) {
      const r = normalize(optionsWith({ [key]: { match: "anthropic/**" } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
  });

  it("rechaza patrones con proveedor extglob, paréntesis o escape", () => {
    for (const match of [
      "(anthropic)/**",
      "@(anthropic)/**",
      "!(anthropic)/**",
      "+(anthropic)/**",
      "(?:anthropic)/**",
      "[anthropic]/**",
      "{anthropic}/**",
      "\\anthropic/**",
      "anthropic|openai/**",
    ]) {
      const r = normalize(optionsWith({ "anthropic/claude": { match } }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("parse-error");
        expect(r.failure.reason).toContain('alias "anthropic/claude"');
      }
    }
  });

  it("acepta proveedores ordinarios con guiones, guiones bajos y dígitos", () => {
    const r = normalize(
      optionsWith({
        "github-copilot/gpt": { match: "github-copilot/**" },
        "openrouter/model": { match: ["openrouter/mistral-*"], exclude: "openrouter/free*" },
        "provider_v2/v3/nightly": { match: "provider_v2/**" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.aliases).toHaveLength(3);
  });

  it("rechaza contenedores de alias malformados", () => {
    const r = normalize(optionsWith({ "anthropic/claude": "anthropic/**" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("parse-error");
  });

  it("cada alias exige match; proveedor literal e igual al de la clave", () => {
    expect(normalize(optionsWith({ "anthropic/claude": {} })).ok).toBe(false);

    for (const match of [[], "openai/**", "*/x", "anth*", "anthropic", "/x", "anthropic/"]) {
      const r = normalize(optionsWith({ "anthropic/claude": { match } }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("parse-error");
        expect(r.failure.reason).toContain('alias "anthropic/claude"');
      }
    }

    const ok = normalize(
      optionsWith({
        "anthropic/claude": { match: ["anthropic/claude-*", "anthropic/nightly/**"] },
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it("exclude es opcional y comparte el proveedor del alias", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/claude": { match: "anthropic/**", exclude: ["anthropic/claude-2*"] },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const alias = ok.config.aliases[0];
      if (!alias) throw new Error("missing alias");
      expect(alias.exclude).toEqual(["anthropic/claude-2*"]);
    }

    for (const exclude of ["openai/**", "claude", "\\**", "anthropic/x#y"]) {
      const r = normalize(optionsWith({ "anthropic/claude": { match: "anthropic/**", exclude } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
  });

  it("valida globs estrictamente y devuelve parse-error sin lanzar", () => {
    for (const pattern of ["anthropic/[abc", "anthropic/[z-a]", "anthropic/a]**[q"]) {
      const r = normalize(optionsWith({ "anthropic/claude": { match: pattern } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
    const ok = normalize(optionsWith({ "anthropic/claude": { match: "anthropic/claude-*" } }));
    expect(ok.ok).toBe(true);
  });

  it("filter.status por alias: activo por defecto, alpha/beta permitidos, deprecated rechazado", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**", filter: { status: ["alpha", "beta"] } },
        "anthropic/b": { match: "anthropic/**" },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.aliases[0]?.statuses).toEqual(["alpha", "beta"]);
      expect(ok.config.aliases[1]?.statuses).toEqual(["active"]);
    }

    const bad: unknown[] = [["deprecated"], ["active", "bogus"], [null], [], "active", {}];
    for (const status of bad) {
      const r = normalize(
        optionsWith({
          "anthropic/a": { match: "anthropic/**", filter: { status } },
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
    // non-object filter
    const r = normalize(
      optionsWith({ "anthropic/a": { match: "anthropic/**", filter: "active" } }),
    );
    expect(r.ok).toBe(false);
  });

  it("filter.capabilities normaliza requisitos exactos y listas all-of", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/a": {
          match: "anthropic/**",
          filter: { capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
        },
        "anthropic/b": { match: "anthropic/**", filter: { capabilities: { tools: false } } },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.aliases[0]?.capabilities).toEqual({
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      });
      expect(ok.config.aliases[0]?.minContext).toBeUndefined();
      expect(ok.config.aliases[1]?.capabilities).toEqual({ tools: false });
    }

    // Only optional fields: an empty object declares no requirement and is a no-op.
    const empty = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**", filter: { capabilities: {} } },
        "anthropic/b": {
          match: "anthropic/**",
          filter: { capabilities: {}, minContext: 128_000 },
        },
      }),
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.config.aliases[0]?.capabilities).toBeUndefined();
      expect(empty.config.aliases[0]?.minContext).toBeUndefined();
      expect(empty.config.aliases[1]?.capabilities).toBeUndefined();
      expect(empty.config.aliases[1]?.minContext).toBe(128_000);
    }

    // No filter at all: no capability requirements.
    const none = normalize(optionsWith({ "anthropic/a": { match: "anthropic/**" } }));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.config.aliases[0]?.capabilities).toBeUndefined();
  });

  it("filter.capabilities rechaza valores malformados y claves desconocidas", () => {
    const bad: unknown[] = [
      "yes",
      3,
      null,
      [],
      { tools: "yes" },
      { tools: 1 },
      { tools: true, toolz: false }, // misspelled capability key
      { tool: true, input: ["text"] }, // misspelled + valid mix
      { input: [] },
      { input: [""] },
      { input: ["text", ""] },
      { input: "text" },
      { input: [42] },
      { input: [null] },
      { output: [] },
      { output: [""] },
      { output: "text" },
      { tools: true, input: ["ok"], output: {} },
    ];
    for (const capabilities of bad) {
      const r = normalize(
        optionsWith({
          "anthropic/a": { match: "anthropic/**", filter: { capabilities } },
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("parse-error");
        expect(r.failure.reason).toContain('alias "anthropic/a"');
      }
    }

    // The misspelled capability key is named explicitly.
    const typo = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**", filter: { capabilities: { toolz: true } } },
      }),
    );
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.failure.reason).toContain("toolz");

    // Unknown keys at the filter level are still rejected.
    const filterTypo = normalize(
      optionsWith({
        "anthropic/a": {
          match: "anthropic/**",
          filter: { capabilites: { tools: true } }, // typo of "capabilities"
        },
      }),
    );
    expect(filterTypo.ok).toBe(false);
    if (!filterTypo.ok) expect(filterTypo.failure.reason).toContain("capabilites");
  });

  it("filter.minContext exige un entero positivo y rechaza lo demas", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**", filter: { minContext: 200_000 } },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.aliases[0]?.minContext).toBe(200_000);
      expect(ok.config.aliases[0]?.capabilities).toBeUndefined();
    }

    for (const minContext of [0, -1, -200_000, 1.5, "200000", true, null, Number.NaN, Infinity]) {
      const r = normalize(
        optionsWith({ "anthropic/a": { match: "anthropic/**", filter: { minContext } } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
  });

  it("filter combina status, capabilities y minContext en un mismo alias", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/a": {
          match: "anthropic/**",
          filter: {
            status: ["active", "alpha"],
            capabilities: { tools: true, input: ["text"] },
            minContext: 128_000,
          },
        },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const alias = ok.config.aliases[0];
      if (!alias) throw new Error("missing alias");
      expect(alias.statuses).toEqual(["active", "alpha"]);
      expect(alias.capabilities).toEqual({ tools: true, input: ["text"] });
      expect(alias.minContext).toBe(128_000);
    }
  });

  it("select por alias: omitido equivale a latest; exige objeto con strategy exacto", () => {
    const ok = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**", select: { strategy: "latest" } },
        "anthropic/b": { match: "anthropic/**" },
      }),
    );
    expect(ok.ok).toBe(true);

    const bad: unknown[] = [
      "latest",
      {},
      { strategy: "cheapest" },
      { strategy: "latest", tiebreak: "id" },
      3,
      null,
    ];
    for (const select of bad) {
      const r = normalize(optionsWith({ "anthropic/a": { match: "anthropic/**", select } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
  });

  it("rechaza claves raíz desconocidas y nombra la errata", () => {
    const r = normalize({ aliases: { "anthropic/a": { match: "anthropic/**" } }, strcit: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("parse-error");
      expect(r.failure.reason).toContain("strcit");
      expect(r.failure.reason).toContain("aliases, strict, debug");
    }
    // Several typos: all of them appear in the reason.
    const multi = normalize({
      aliases: { "anthropic/a": { match: "anthropic/**" } },
      strcit: true,
      debgu: false,
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.failure.reason).toContain("strcit");
      expect(multi.failure.reason).toContain("debgu");
    }
  });

  it("rechaza claves de alias desconocidas con contexto de la clave del alias", () => {
    const r = normalize(
      optionsWith({ "anthropic/a": { match: "anthropic/**", exlude: "anthropic/x*" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("parse-error");
      expect(r.failure.reason).toContain('alias "anthropic/a"');
      expect(r.failure.reason).toContain("exlude");
      expect(r.failure.reason).toContain("match, exclude, filter, select, name");
    }
  });

  it("rechaza claves desconocidas en filter con contexto del alias", () => {
    const r = normalize(
      optionsWith({ "anthropic/a": { match: "anthropic/**", filter: { statuses: ["active"] } } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("parse-error");
      expect(r.failure.reason).toContain('alias "anthropic/a"');
      expect(r.failure.reason).toContain("filter");
      expect(r.failure.reason).toContain("statuses");
    }
  });

  it("name opcional no vacío por alias; strict/debug globales booleanos", () => {
    const ok = normalize(
      optionsWith(
        {
          "anthropic/a": { match: "anthropic/**", name: "Probe" },
          "anthropic/b": { match: "anthropic/**" },
        },
        { strict: true, debug: false },
      ),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.aliases[0]?.name).toBe("Probe");
      expect(ok.config.aliases[0]?.nameExplicit).toBe(true);
      expect(ok.config.aliases[1]?.name).toBe("anthropic/b");
      expect(ok.config.aliases[1]?.nameExplicit).toBe(false);
      expect(ok.config.strict).toBe(true);
      expect(ok.config.debug).toBe(false);
    }

    for (const name of ["", 3]) {
      const r = normalize(optionsWith({ "anthropic/a": { match: "anthropic/**", name } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
    for (const key of ["strict", "debug"] as const) {
      const r = normalize({ ...okOptions(), [key]: "yes" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("parse-error");
    }
  });

  it("nunca lanza aunque cualquier alias contenga un glob inválido", () => {
    const r = normalize(
      optionsWith({
        "anthropic/a": { match: "anthropic/**" },
        "anthropic/b": { match: "anthropic/[bad" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain('alias "anthropic/b"');
  });
});
