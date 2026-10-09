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

/** Wraps an alias-fragment fence (bare `"<key>": { ... }` entries) into a
 *  complete options document; trailing commas are tolerated. */
function wrapAliasFragment(body: string, source: string): Record<string, unknown> {
  return parseJsoncDoc(`{"aliases": {\n${body}\n}}`, source);
}

function optionsFromJsonExample(body: string, source: string): unknown[] {
  if (/^\s*"[^"]+"\s*:/u.test(body)) {
    return [wrapAliasFragment(body, source)];
  }
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
  it("the schema URL shown in the README matches the schema $id", () => {
    expect(readme).toContain(String(schema.$id));
    expect(schema.$id).toBe(
      "https://raw.githubusercontent.com/vmvarela/opencode-model-aliases/v0.4.0/schema.json",
    );
  });

  it("```jsonc fences are complete file configs: parsed, $schema = $id, schema-valid", () => {
    const jsoncFences = fences.filter((fence) => fence.lang === "jsonc");
    expect(jsoncFences.length).toBeGreaterThan(0);
    for (const fence of jsoncFences) {
      const doc = parseJsoncDoc(fence.body, "jsonc fence");
      const schemaUrl = doc.$schema;
      expect(schemaUrl, "file example must point at the published schema").toBe(schema.$id);
      expect(errorsOf(doc), fence.body).toBeUndefined();
    }
  });

  it("```json fences are complete options docs, opencode configs or alias fragments — all covered and schema-valid", () => {
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
