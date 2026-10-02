# opencode-floating-models

An [OpenCode](https://opencode.ai) v2 plugin that materializes **floating model aliases** into
the model catalog. Configure an alias once and the plugin picks the newest matching source
model at every catalog refresh, exposing it under a stable ID — so the selection follows the
provider's latest release without touching your configuration.

## How it works

For each configured alias the plugin:

1. **Matches** candidates with include/exclude globs (fully qualified, provider-isolated).
2. **Filters** by `enabled` and by the alias's allowed statuses (default: `active` only).
3. **Selects** the winner with the `latest` strategy: newest `time.released` timestamp wins;
   exact ties fall back to code-unit descending model ID; candidates without a reliable
   timestamp (not a finite, positive number) never beat dated ones, and an alias whose
   eligible candidates all lack one is reported as unresolved (`missing-metadata`) rather
   than guessed.

The winner is materialized as a full clone of its `Model.Info` under the alias ID (same
provider), preserving the winner's metadata (`modelID`, `package`, `canonical`, `family`,
`compatibility`, `settings`, `headers`, `body`, `capabilities`, `variants`, `time`, `cost`,
`status`, `enabled`, `limit`). The selectable `id` and execution `modelID` remain
distinguishable, exactly as in OpenCode's own model types.

## Configuration

There are two ways to configure the plugin, and both can be combined:

1. **Separate JSONC file (preferred)** — a `.opencode/opencode-floating-models.jsonc`
   file next to your project.
2. **Inline `options`** — the plugin entry's `options` object, passed by the host directly
   to `ctx.options` (backwards compatible).

### Separate config file (preferred)

The plugin reads a single `.opencode/opencode-floating-models.jsonc` file at setup time.
It looks for the **nearest** file, walking upward from the server's working directory
(`ctx.location.directory`) to the filesystem root, so a workspace-level file still applies
even when the session runs inside a nested git repository. The first file found wins:
ancestral files are not merged, and global OpenCode directories are never consulted.

The file is JSONC (comments and trailing commas allowed):

```jsonc
// .opencode/opencode-floating-models.jsonc
{
  "aliases": {
    "github-copilot/sonnet": {
      "match": "github-copilot/claude-sonnet-*",
      "exclude": ["github-copilot/*-preview"],
      "filter": { "status": ["active", "alpha"] },
      "select": { "strategy": "latest" },
      "name": "Sonnet (floating)"
    },
    "anthropic/smart": {
      "match": ["anthropic/claude-*"]
    },
  },
  "strict": false,
  "debug": false,
}
```

With this setup the `opencode.json` plugin entry only needs the package:

```json
{
  "plugins": [
    { "package": "opencode-floating-models" }
  ]
}
```

### Inline options (backwards compatible)

Alternatively (or additionally), the host passes the plugin entry's `options` object
directly to `ctx.options`:

```json
{
  "plugins": [
    {
      "package": "opencode-floating-models",
      "options": {
        "aliases": {
          "github-copilot/sonnet": {
            "match": "github-copilot/claude-sonnet-*",
            "exclude": ["github-copilot/*-preview"],
            "filter": { "status": ["active", "alpha"] },
            "select": { "strategy": "latest" },
            "name": "Sonnet (floating)"
          },
          "anthropic/smart": {
            "match": ["anthropic/claude-*"]
          }
        },
        "strict": false,
        "debug": false
      }
    }
  ]
}
```

Place this plugin before downstream plugins that consume its aliases so their setup runs
after the alias transform is registered.

#### Precedence between file and inline options

When both sources are present, the file is the base and the inline `options` win:

- Supplied top-level inline values (`strict`, `debug`) override the file's — an explicit
  inline `false` is respected.
- The alias maps are **unioned by key**; for the same key, the inline alias record
  **replaces the file's complete record** (no field-by-field merging).

The config file is read once at plugin setup; editing it afterwards requires reloading
the plugin or restarting the OpenCode server to take effect. A missing file is not an error as long
as `aliases` is supplied inline; the merged configuration must still contain `aliases`
(an empty object `{}` is a valid no-op).

Global options:

- `aliases` — required object keyed `"<provider>/<aliasModelID>"` (the alias model ID may
  contain `/`; the provider is the part before the first `/`). An empty object is a valid
  no-op.
- `strict` — default `false`.
- `debug` — default `false`.

Per-alias options:

- `match` — required string or string array. Every pattern must be fully qualified as
  `"provider/glob"`, and its provider must be a **literal** that exactly equals the alias
  key's provider (cross-provider patterns and wildcard/extglob provider segments are
  rejected). Globs are compiled with [picomatch](https://github.com/micromatch/picomatch)
  and validated strictly: malformed patterns (unbalanced brackets, invalid ranges such as
  `[z-a]`) are configuration errors, never silent mismatches.
- `exclude` — optional string or string array, same qualification rules as `match`.
- `filter.status` — optional non-empty array of `active`, `alpha`, `beta`. Defaults to
  `["active"]`; `deprecated` and unknown statuses are rejected at startup.
- `select` — optional; if present it must be `{ "strategy": "latest" }`, which is also the
  default. No other strategy is supported yet.
- `name` — optional non-empty display name. The configured name is used verbatim, even when
  it equals the alias key. Without it, the label is derived deterministically from the alias
  ID's last path segment (`"sonnet"` → `"Sonnet (floating)"`) and stays stable even when the
  selected target changes.

## Errors, warnings and logging

- A malformed configuration fails plugin setup before any transform is registered.
- An alias ID that already exists as a source model under that provider is a **configuration
  collision**: it is fatal and the source model is never overwritten, even when disabled or
  unresolved.
- `strict: true` — the transform is registered first; if an alias cannot resolve on the
  initial catalog read, that replay fails and the host rolls it back, so setup rejects and
  disposes the registration **before any alias is materialized**. On later catalog
  refreshes, a resolution failure instead propagates to the host, which rolls back and
  removes the plugin's transform group for that replay (the plugin stays disabled until a
  successful setup).
- Default (tolerant) — each unresolved alias logs a warning (`console.warn`) and is omitted;
  the other aliases keep working.
- Successful resolution is silent by default. With `debug: true` each alias logs its
  matched/eligible counts, strategy, selected target ID and released timestamp as a
  `console.warn` line prefixed with `[opencode-floating-models] [debug]` (the v2.0.x host
  swallows plugin `console.debug`, so `console.warn` is the only passthrough channel for
  diagnostics). Only public model metadata is ever logged — no credentials, secrets or
  prompt content.

## Limitations

- Only `strategy: "latest"` is implemented; other strategies are rejected during
  normalization.
- Aliases are resolved against the fresh source catalog on every replay; a generated alias
  never feeds another alias, and declaration order does not affect winners.
- If a resolved target disappears, tolerant mode warns and the alias is omitted until a
  matching candidate returns.
- The plugin never polls or fetches external catalogs; it only reacts to OpenCode's own
  model catalog refreshes.

## Development

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm run verify   # lint + typecheck + tests + build (self-contained)
pnpm run build    # emit dist/
pnpm run test     # vitest
pnpm run check    # biome
```

### Real-host smoke (opt-in)

`pnpm smoke:opencode` runs an end-to-end smoke against a locally **installed
OpenCode v2 CLI** (`opencode --version` must report major version 2; verified
against v2.0.22). It is POSIX-only (fails fast on win32) and is NOT part of
`pnpm verify` or CI — CI runners don't install OpenCode, and `pnpm verify`
remains fully self-contained.

The smoke builds the product first (stale `dist/` cannot pass), then `pnpm
pack`s it and extracts the tarball into a fresh temp tree, linking the repo's
existing `node_modules` for the runtime peer dependency — no registry
downloads or external installs (the package is not published; the npm
publishing/install path is NOT tested). It loads the **packed product package
itself** through the official `plugins` config entry — with **file-only
configuration**: the entry carries no `options` and the aliases/strict/debug
come exclusively from a `.opencode/opencode-floating-models.jsonc` file
(JSONC comments + trailing commas) in the temp project — and a local
models.dev-format catalog (`OPENCODE_MODELS_PATH` +
`OPENCODE_DISABLE_MODELS_FETCH=1`), against a loopback-only fake
OpenAI-compatible endpoint. `HOME`/XDG directories are unique temp dirs and
the CLI subprocesses receive only a minimal allow-listed environment — no
inherited credentials, just the fake provider's dummy test key. A downstream
consumer plugin loaded after the product independently asserts the host
catalog: `localfake/latest` selectable, `enabled=true`, execution
`modelID=fake-large`.

Assertions (all required): process exit 0 under the bounded timeout (whole
child process group killed on timeout); a genuine assistant `text` stdout
event with exactly `pong` from `--format json` (never a substring of an echoed
prompt); every chat request carries `body.model === "fake-large"` (the
`latest`-strategy winner) and the dummy key; the consumer catalog sentinel and
the `[opencode-floating-models] [debug]` alias→winner line appear in stderr;
no "failed to load plugin". The temp tree, server and subprocess groups are
always cleaned up.

```sh
TMPDIR=/path/to/approved-tmp pnpm smoke:opencode
```

> This package is not published to npm yet. For local development, point a
> `plugins` config entry directly at the built repo/product directory — the
> root `index.js` entrypoint loads as-is, no manual shim needed.

Pure config normalization and resolution live in `src/normalize.ts` / `src/resolve.ts`; the
JSONC config-file loader is `src/config-file.ts`; the OpenCode v2 adapter is `src/plugin.ts`.

## License

MIT — see [LICENSE](LICENSE).
