import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { normalizeOptions } from "../src/normalize.js";

const SCHEMA_PATH = path.join(import.meta.dirname, "..", "schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

const SCHEMA_URL =
  "https://raw.githubusercontent.com/vmvarela/opencode-model-aliases/v0.4.0/schema.json";

// Validation only: no coerceTypes/useDefaults/removeAdditional, so the
// compiled schema describes the same shape normalizeOptions consumes.
const ajv = new Ajv();
const metaValid = ajv.validateSchema(schema);
if (!metaValid) throw new Error(`schema.json is not a valid draft-07 schema: ${ajv.errorsText()}`);
const validate = ajv.compile(schema as object);
const errorsOf = (doc: unknown): string | undefined => {
  validate(doc);
  return validate.errors ? ajv.errorsText(validate.errors) : undefined;
};

/** Schema-valid documents: no Ajv errors. */
function expectValid(doc: unknown) {
  expect(errorsOf(doc), JSON.stringify(doc)).toBeUndefined();
}

/** Schema-invalid documents: at least one error mentioning the fragment. */
function expectInvalid(doc: unknown, fragment: string) {
  const errors = errorsOf(doc);
  expect(errors, JSON.stringify(doc)).toBeDefined();
  expect(errors).toContain(fragment);
}

const alias = (key: string, config: Record<string, unknown>) => ({
  aliases: { [key]: config },
});

describe("schema.json contract (draft-07, Ajv)", () => {
  it("is a structurally valid draft-07 schema and compiles", () => {
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.$id).toBe(SCHEMA_URL);
    // validateSchema + compile already ran at module load; reaching here
    // proves both succeeded.
  });

  it("never enforces uniqueItems (duplicate items are preserved)", () => {
    expect(JSON.stringify(schema)).not.toContain("uniqueItems");
    expectValid(alias("anthropic/float", { match: ["anthropic/a", "anthropic/a"] }));
  });

  it("accepts a full configuration with every option level", () => {
    expectValid({
      $schema: SCHEMA_URL,
      aliases: {
        "anthropic/float": {
          match: "anthropic/claude-*",
          exclude: ["anthropic/claude-a"],
          filter: {
            status: ["active", "beta"],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            minContext: 1,
          },
          select: { strategy: "latest" },
          name: "Float",
        },
        "anthropic/edge": { match: ["anthropic/claude-*"], exclude: [] },
      },
      strict: false,
      debug: true,
    });
  });

  it("allows aliases omitted at file level and an empty capabilities object", () => {
    expectValid({});
    expectValid({ strict: true, debug: false });
    expectValid(alias("anthropic/float", { match: "anthropic/**", filter: { capabilities: {} } }));
  });
});

describe("unknown keys are rejected at every level", () => {
  it("root typo", () => {
    expectInvalid({ strcit: true }, "must NOT have additional properties");
    expectInvalid({ aliases: { "a/m": { match: "a/**" } }, $schema: 3 }, "must be string");
  });

  it("alias level", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", macth: "a/**" }),
      "must NOT have additional properties",
    );
  });

  it("filter level", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { stauts: ["active"] } }),
      "must NOT have additional properties",
    );
  });

  it("capabilities level", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { capabilities: { toolz: true } } }),
      "must NOT have additional properties",
    );
  });

  it("select level", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", select: { strategy: "latest", tieBreak: "x" } }),
      "must NOT have additional properties",
    );
  });
});

describe("field constraints", () => {
  it("aliases container must be an object", () => {
    expectInvalid({ aliases: [] }, "must be object");
    expectInvalid({ aliases: null }, "must be object");
  });

  it("match is required and non-empty (string or non-empty array)", () => {
    expectInvalid(alias("a/m", {}), "must have required property 'match'");
    expectInvalid(alias("a/m", { match: "" }), "must match exactly one schema in oneOf");
    expectInvalid(alias("a/m", { match: [] }), "must match exactly one schema in oneOf");
    expectInvalid(alias("a/m", { match: ["a/**", ""] }), "must match exactly one schema in oneOf");
    expectInvalid(alias("a/m", { match: 1 }), "must match exactly one schema in oneOf");
  });

  it("exclude is an optional non-empty string or array (empty array valid)", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", exclude: "" }),
      "must match exactly one schema in oneOf",
    );
    expectInvalid(
      alias("a/m", { match: "a/**", exclude: 1 }),
      "must match exactly one schema in oneOf",
    );
  });

  it("filter.status is a non-empty array of allowed statuses", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { status: [] } }),
      "must NOT have fewer than 1 items",
    );
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { status: ["deprecated"] } }),
      "must be equal to one of the allowed values",
    );
    expectInvalid(alias("a/m", { match: "a/**", filter: { status: "active" } }), "must be array");
  });

  it("filter.capabilities: tools boolean, non-empty modality arrays", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { capabilities: { tools: "true" } } }),
      "must be boolean",
    );
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { capabilities: { input: [] } } }),
      "must NOT have fewer than 1 items",
    );
    expectInvalid(
      alias("a/m", { match: "a/**", filter: { capabilities: { output: [""] } } }),
      "must NOT have fewer than 1 characters",
    );
  });

  it("filter.minContext is a positive integer", () => {
    expectInvalid(alias("a/m", { match: "a/**", filter: { minContext: 0 } }), "must be >= 1");
    expectInvalid(alias("a/m", { match: "a/**", filter: { minContext: 1.5 } }), "must be integer");
    expectInvalid(alias("a/m", { match: "a/**", filter: { minContext: "1" } }), "must be integer");
  });

  it("select, when present, is exactly { strategy: 'latest' }", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", select: {} }),
      "must have required property 'strategy'",
    );
    expectInvalid(
      alias("a/m", { match: "a/**", select: { strategy: "oldest" } }),
      "must be equal to one of the allowed values",
    );
  });

  it("name is a non-empty string", () => {
    expectInvalid(
      alias("a/m", { match: "a/**", name: "" }),
      "must NOT have fewer than 1 characters",
    );
  });
});

describe("alias keys are `<literal provider>/<non-empty model>` without #", () => {
  const withKey = (key: string) => alias(key, { match: "anthropic/**" });

  it("accepts literal providers, models with globs and nested slashes", () => {
    expectValid(withKey("anthropic/claude-*"));
    expectValid(withKey("anthropic/claude/a"));
  });

  it("rejects keys without a slash, empty provider or empty model", () => {
    expectInvalid(withKey("no-slash"), "must match pattern");
    expectInvalid(withKey("/model"), "must match pattern");
    expectInvalid(withKey("provider/"), "must match pattern");
  });

  it("rejects non-literal providers and keys containing #", () => {
    expectInvalid(withKey("prov*ider/m"), "must match pattern");
    expectInvalid(withKey("p?/m"), "must match pattern");
    expectInvalid(withKey("anthropic/m#1"), "must match pattern");
    expectInvalid(withKey("anthropic/a/b#c"), "must match pattern");
  });

  it("rejects match patterns without `<provider>/<model>` shape or with #", () => {
    expectInvalid(alias("a/m", { match: "claude-*" }), "must match pattern");
    expectInvalid(alias("a/m", { match: "prov*ider/m" }), "must match pattern");
    expectInvalid(alias("a/m", { match: "a/b#c" }), "must match pattern");
  });
});

/**
 * Runtime parity: representative documents are compared against BOTH the
 * compiled schema and normalizeOptions. Semantic-only constraints are
 * intentionally NOT part of the schema (glob compilation, provider
 * equality between match patterns and the alias key, catalog collisions):
 * a doc that is schema-valid can still fail at runtime for those reasons.
 */
const validWithoutMetadata: unknown[] = [
  alias("anthropic/float", { match: "anthropic/claude-*" }),
  alias("anthropic/float", {
    match: ["anthropic/claude-*", "anthropic/haiku-**"],
    exclude: ["anthropic/claude-a"],
    filter: {
      status: ["beta"],
      capabilities: { tools: true, input: ["text"] },
      minContext: 32_000,
    },
    select: { strategy: "latest" },
    name: "Float",
  }),
  { aliases: {}, strict: true, debug: false },
  { aliases: { "anthropic/float": { match: "anthropic/**", filter: { capabilities: {} } } } },
];

const invalidDocs: unknown[] = [
  { strcit: true, aliases: {} },
  alias("a/m", { macth: "a/**" }),
  alias("a/m", { match: "a/**", filter: { stauts: ["active"] } }),
  alias("a/m", { match: "a/**", filter: { capabilities: { toolz: true } } }),
  alias("a/m", { match: "a/**", select: { strategy: "latest", tieBreak: "x" } }),
  alias("a/m", {}),
  alias("a/m", { match: [] }),
  alias("a/m", { match: "" }),
  alias("a/m", { match: "a/**", filter: { status: ["deprecated"] } }),
  alias("a/m", { match: "a/**", filter: { capabilities: { tools: "true" } } }),
  alias("a/m", { match: "a/**", filter: { capabilities: { input: [] } } }),
  alias("a/m", { match: "a/**", filter: { minContext: 0 } }),
  alias("a/m", { match: "a/**", filter: { minContext: 1.5 } }),
  alias("a/m", { match: "a/**", select: {} }),
  alias("a/m", { match: "a/**", select: { strategy: "oldest" } }),
  alias("a/m", { match: "a/**", name: "" }),
  alias("no-slash", { match: "a/**" }),
  alias("prov*ider/m", { match: "a/**" }),
  alias("a/m#x", { match: "a/**" }),
  { aliases: [] },
  { aliases: null },
];

describe("runtime parity with normalizeOptions", () => {
  it("schema-valid docs (without $schema metadata) are accepted by normalizeOptions", () => {
    for (const doc of validWithoutMetadata) {
      expect(errorsOf(doc), JSON.stringify(doc)).toBeUndefined();
      expect(normalizeOptions(doc as never).ok, JSON.stringify(doc)).toBe(true);
    }
  });

  it("schema-invalid docs are also rejected by normalizeOptions", () => {
    for (const doc of invalidDocs) {
      expect(errorsOf(doc), JSON.stringify(doc)).toBeDefined();
      expect(normalizeOptions(doc as never).ok, JSON.stringify(doc)).toBe(false);
    }
  });

  it("prototype-named own keys (via JSON.parse) are rejected by both", () => {
    const hostileRoot = JSON.parse(
      '{"aliases": {"anthropic/float": {"match": "anthropic/**"}}, "constructor": 1}',
    );
    expect(errorsOf(hostileRoot)).toContain("must NOT have additional properties");
    expect(normalizeOptions(hostileRoot as never).ok).toBe(false);

    const hostileAliasKey = JSON.parse('{"aliases": {"__proto__": {"match": "anthropic/**"}}}');
    expect(errorsOf(hostileAliasKey)).toBeDefined();
    expect(normalizeOptions(hostileAliasKey as never).ok).toBe(false);
  });

  it("intentional divergence: aliases may be omitted at file level, but the merged runtime config requires it", () => {
    // File-level schema allows the omission (inline options supply it);
    // normalizeOptions over the merged config requires the container.
    expect(errorsOf({})).toBeUndefined();
    expect(normalizeOptions({} as never).ok).toBe(false);
  });

  it("intentional divergence: $schema is valid file metadata, never accepted inline", () => {
    // Schema-valid as file metadata...
    expectValid({ $schema: SCHEMA_URL, aliases: {} });
    // ...the file layer strips it (see config-file tests) so the merged
    // config validates; inline options are rejected by normalizeOptions.
    expect(normalizeOptions({ $schema: SCHEMA_URL, aliases: {} } as never).ok).toBe(false);
  });

  it("semantic-only: provider equality between match and alias key is left to the runtime", () => {
    // Schema-valid shape; normalizeOptions rejects the provider mismatch.
    const doc = alias("anthropic/float", { match: "openai/gpt-*" });
    expect(errorsOf(doc)).toBeUndefined();
    expect(normalizeOptions(doc as never).ok).toBe(false);
  });
});
