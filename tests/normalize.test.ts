import { describe, expect, it } from "vitest";
import type { Options } from "../src/index.js";
import { normalizeOptions, splitSelector } from "../src/index.js";

/** Construye Options con valores deliberadamente inválidos en los tests. */
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
    // filter no-objeto
    const r = normalize(
      optionsWith({ "anthropic/a": { match: "anthropic/**", filter: "active" } }),
    );
    expect(r.ok).toBe(false);
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
      expect(ok.config.aliases[1]?.name).toBe("anthropic/b");
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
