import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { type ParseError, parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

const SCHEMA_PATH = path.join(import.meta.dirname, "..", "schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

// Same policy as the schema contract tests: validation only.
const ajv = new Ajv();
if (!ajv.validateSchema(schema)) throw new Error(ajv.errorsText());
const validate = ajv.compile(schema);

const README_PATH = path.join(import.meta.dirname, "..", "README.md");
const readme = readFileSync(README_PATH, "utf8");

/** Stable schema URL shown in the README; follows the default branch. */
const MASTER_SCHEMA_URL =
  "https://raw.githubusercontent.com/vmvarela/opencode-model-aliases/master/schema.json";

const fences = [...readme.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((match) => ({
  lang: match[1] ?? "",
  body: match[2] ?? "",
}));

/** Parses a complete JSONC document and fails on any parse error. */
function parseJsoncDoc(body: string, source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const doc = parse(body, errors, { allowTrailingComma: true });
  const first = errors[0];
  expect(first, source).toBeUndefined();
  expect(typeof doc === "object" && doc !== null && !Array.isArray(doc), source).toBe(true);
  return doc as Record<string, unknown>;
}

function optionsFromJsonExample(body: string, source: string): unknown[] {
  const doc = parseJsoncDoc(body, source);
  if ("plugins" in doc) {
    expect(Array.isArray(doc.plugins), source).toBe(true);
    const plugins = doc.plugins as unknown[];
    const configured = plugins.filter(
      (plugin): plugin is Record<string, unknown> =>
        typeof plugin === "object" &&
        plugin !== null &&
        typeof (plugin as Record<string, unknown>).package === "string" &&
        ((plugin as Record<string, string>).package ?? "").startsWith("opencode-model-aliases"),
    );
    expect(configured.length, `${source}: configured plugin`).toBeGreaterThan(0);
    return configured.map((plugin) => {
      expect(Object.hasOwn(plugin, "options"), `${source}: plugin options`).toBe(true);
      return plugin.options;
    });
  }
  if ("aliases" in doc) return [doc];
  throw new Error(`${source}: unrecognized configuration example`);
}

describe("README examples validate against schema.json", () => {
  it("the README shows the stable master schema URL", () => {
    expect(readme).toContain(MASTER_SCHEMA_URL);
  });

  it("```jsonc fences are complete file configs: parsed, $schema = master URL, schema-valid", () => {
    const jsoncFences = fences.filter((fence) => fence.lang === "jsonc");
    expect(jsoncFences.length).toBeGreaterThan(0);
    for (const fence of jsoncFences) {
      const doc = parseJsoncDoc(fence.body, "jsonc fence");
      const schemaUrl = doc.$schema;
      expect(schemaUrl, "file example must point at the master schema").toBe(MASTER_SCHEMA_URL);
      expect(errorsOf(doc), fence.body).toBeUndefined();
    }
  });

  it("```json fences are complete OpenCode configs or options documents — all covered and schema-valid", () => {
    let covered = 0;
    for (const fence of fences.filter((entry) => entry.lang === "json")) {
      const source = fence.body.slice(0, 60);
      for (const options of optionsFromJsonExample(fence.body, source)) {
        expect(errorsOf(options), source).toBeUndefined();
      }
      covered += 1;
    }
    // No ```json fence is silently skipped.
    expect(covered).toBe(fences.filter((entry) => entry.lang === "json").length);
  });

  it("rejects bare alias fragments; every example must be a complete document", () => {
    expect(() =>
      optionsFromJsonExample('"openai/latest": { "match": "openai/gpt-*" }', "bare fragment"),
    ).toThrow();
  });

  it("rejects malformed complete configs instead of validating recovered parser data", () => {
    expect(() =>
      optionsFromJsonExample(
        '{"plugins":[{"package":"opencode-model-aliases@latest","options":{"aliases":{}}}',
        "truncated config",
      ),
    ).toThrow();
  });

  it("requires intended OpenCode plugin options to be found and validated", () => {
    const renamed = JSON.stringify({
      plugins: [{ package: "opencode-model-aliases@latest", optoins: { aliases: {} } }],
    });
    expect(() => optionsFromJsonExample(renamed, "missing options")).toThrow();
  });
});

function errorsOf(doc: unknown): string | undefined {
  validate(doc);
  return validate.errors ? ajv.errorsText(validate.errors) : undefined;
}
