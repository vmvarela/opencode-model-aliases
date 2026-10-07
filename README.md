# opencode-model-aliases

[![npm version](https://img.shields.io/npm/v/opencode-model-aliases.svg)](https://www.npmjs.com/package/opencode-model-aliases)
[![CI](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml/badge.svg)](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Stop hardcoding model versions in your OpenCode config.**

An [OpenCode](https://opencode.ai) v2 plugin that materializes **floating model aliases**
into the model catalog. Configure an alias once — say `anthropic/smart` — and the plugin
picks the newest matching source model at every catalog refresh, exposing it under a stable
ID. Your configuration and prompts keep working as the provider ships new models; you never
hard-code a model ID that goes stale.

A concrete reference pins a model. A floating alias names a selection policy: the stable
ID stays the same while its eligible target can change. Use a concrete reference when
you want to keep a specific model; use this plugin when you want to follow a model family.

## Why

Model IDs age badly: Sonnet gets point releases, `*-preview` snapshots get promoted, and
hard-coded references in OpenCode configs and agent definitions go stale. This plugin lets
you define a floating alias once and resolve it on each catalog refresh:

- **Future-proof config** — define "the newest matching Sonnet" or "the newest Copilot
  model with tools and image input" once; it tracks newly released matching models at the
  next catalog refresh.
- **Constrained picks are first-class** — filterable by tools, modalities, and minimum
  context, so an alias means "the newest model that *can* do this", not just "the newest".
- **Predictable and observable** — deterministic selection rules (no declaration-order
  surprises), provider-isolated matching, and `/model-aliases` shows exactly what each
  alias resolved to.
- **Fail-safe by default** — malformed patterns are rejected at startup; unresolved aliases
  just warn and are omitted, leaving other aliases unaffected.

## Quick Start

Add the plugin to `opencode.json`:

```json
{
  "plugins": [
    { "package": "opencode-model-aliases@latest" }
  ]
}
```

Then define aliases in `.opencode/opencode-model-aliases.jsonc` next to your project:

```jsonc
{
  "aliases": {
    "anthropic/smart": {
      "match": ["anthropic/claude-sonnet-*"],
      "exclude": ["anthropic/*-preview"],
      "name": "Sonnet (floating)"
    },
    "github-copilot/agentic": {
      "match": "github-copilot/gpt-*",
      "filter": {
        "capabilities": { "tools": true, "input": ["image"] },
        "minContext": 128000
      }
    }
  }
}
```

Restart OpenCode. Type `/model-aliases` to see what each alias resolved to.

> OpenCode caches installed plugin packages. Apply a newer release with
> `opencode plugin update opencode-model-aliases@latest`; restarting alone won't update it.

## How it works

For each configured alias the plugin, at every catalog refresh:

```
match ──► filter ──► select ──► materialize
  │           │          │
  │ provider- │ status/  │ latest
  │ isolated  │ caps/ctx │ wins
  │ globs     │ ANDed    │
```

1. **Matches** candidates with include/exclude globs. Patterns are fully qualified
   (`"provider/glob"`) and provider-isolated: the pattern's provider must be a literal that
   equals the alias key's provider — cross-provider patterns and wildcard provider segments
   are rejected. Globs are compiled with
   [picomatch](https://github.com/micromatch/picomatch); malformed patterns are
   configuration errors, never silent mismatches.
2. **Filters** by `enabled`, `filter.status` (default: `active` only) and any
   `filter.capabilities` / `filter.minContext` requirements. All configured filters AND
   together; a candidate missing the metadata a filter requires (capabilities, context
   limit) fails that filter. Filters decide eligibility only — they never influence
   ranking.
3. **Selects** the winner with the `latest` strategy: newest `time.released` timestamp
   wins, exact ties fall back to descending model ID, and candidates without a reliable
   timestamp never beat dated ones. This is the only strategy.

The winner is materialized as a full clone of its model info under the alias ID (same
provider), preserving execution metadata. The selectable catalog `id` and the wire
`modelID` used at execution time remain distinguishable: requests through the alias carry
the winner's `modelID`. Resolution is provider-isolated — an alias only ever matches within
its own key's provider, and declaration order or other aliases never affect a winner
(aliases do not chain).

## Configuration

Two sources, combinable:

1. **JSONC config file (preferred)** — `.opencode/opencode-model-aliases.jsonc`.
2. **Inline `options`** — the `options` object in the plugin entry.

When both are present, the file is the base and inline options win: supplied `strict`/`debug`
values override the file's, and the alias maps are unioned by key — for the same key the
inline record **replaces** the file's complete record (no field-by-field merging).

The file is JSONC (comments and trailing commas allowed). It is read **once** at plugin
setup, looking for the **nearest** file walking upward from the server's working directory;
the first file found wins, ancestral files are not merged. Editing it afterwards requires a
restart. A missing file is fine as long as `aliases` is supplied inline; an empty `aliases`
object is a valid no-op.

Inline form:

```json
{
  "plugins": [
    {
      "package": "opencode-model-aliases@latest",
      "options": {
        "aliases": {
          "anthropic/smart": { "match": ["anthropic/claude-sonnet-*"] }
        }
      }
    }
  ]
}
```

Place this plugin before downstream plugins that consume its aliases, so their setup runs
after the alias transform is registered.

### Options reference

**Global**

- `aliases` — required. Object keyed `"<provider>/<aliasModelID>"` (the alias model ID may
  contain `/`; the provider is the part before the first `/`).
- `strict` — default `false`. See [Failure behavior](#failure-behavior).
- `debug` — default `false`. Logs per-alias resolution diagnostics (as warnings — the
  OpenCode v2.0.x host swallows plugin `console.debug`). Only public model metadata is
  ever logged.

**Per alias**

- `match` — required, string or string array of fully qualified `"provider/glob"` patterns
  (see [How it works](#how-it-works)).
- `exclude` — optional, same rules as `match`.
- `filter.status` — optional non-empty array of `active`, `alpha`, `beta`. Defaults to
  `["active"]`; `deprecated` and unknown statuses are rejected at startup.
- `filter.capabilities` — optional object with any of:
  - `tools` — boolean, requires exact equality with the candidate's `capabilities.tools`.
  - `input` / `output` — arrays of modality strings, all-of semantics: every listed modality
    must be present in the candidate's capabilities. Modality strings are open-ended
    (whatever OpenCode reports), not a fixed enum. Empty modality lists/strings and
    non-boolean `tools` are rejected at startup.
  - An empty `capabilities: {}` is a no-op.
- `filter.minContext` — optional positive integer; the candidate's `limit.context` must be
  `>=` it (inclusive).
- `select` — optional; only `{ "strategy": "latest" }` is accepted, which is the default.
- `name` — optional non-empty display name, used verbatim. Without it, the label is derived
  from the alias ID's last path segment (`"sonnet"` → `"Sonnet (alias)"`) and stays stable
  even when the selected target changes.

## Failure behavior

- A malformed configuration fails plugin setup before any transform is registered. Unknown
  keys at any level are rejected.
- An alias ID that already exists as a source model under that provider is a **collision**:
  fatal, and the source model is never overwritten.
- **Default (tolerant):** an alias that cannot resolve logs a warning and is omitted; the
  other aliases keep working. If a resolved target later disappears, the alias is omitted
  (with a warning) until a matching candidate returns.
- **`strict: true`:** setup fails when the initial resolution of any alias fails, instead
  of silently starting without it.

## Inspecting aliases (`/model-aliases`)

Type `/model-aliases` in the composer (in OpenCode 2.0.22, selecting the slash suggestion
completes the command with a trailing space — press Enter again) or use **Model aliases**
in the command palette. The report shows each alias with its selected target (or unresolved
status and reason), plus a detail view with the full alias key, canonical target, execution
`modelID` and selection strategy. Inspection never calls a model.

In a server-only setup (no TUI), the same report is available through the CLI:

```sh
opencode api --standalone post /api/rpc/opencode-model-aliases/inspect --data '{"input":{}}'
```

The report reflects the last **successful** catalog replay; if the last replay failed, you
get a clear "unavailable" message instead of a stale mapping. With no aliases configured
the report is `No aliases configured.`

### Target changes

The first confirmed resolution establishes a silent baseline. Later changes show a
grouped TUI toast and remain visible in `/model-aliases`, including the previous target,
current target and detection time. Inspection RPC rows expose the same optional
`transition` object. A change in the execution `modelID` also counts, even when the catalog
ID stays the same. Changes may move to an older model; notifications do not claim upgrades.

History uses OpenCode's native plugin storage, scoped by directory/workspace and each
alias's effective selection policy. Changing a policy resets that alias's baseline;
renaming it or changing debug/strict settings does not. Only the last confirmed target
and the most recent transition are stored. `changedAt` is the observation time, not the
model's release date. Failed reads, unresolved aliases and inactive mappings do not
overwrite the baseline. Recovery to the same target produces no new transition.

The server observes native `model.updated` events and confirmed inspection reads, even
without a TUI. Each open TUI keeps local notification acknowledgments. Native TUI storage
also remembers acknowledgments across restarts of the same profile; newly opened clients
sharing that profile inherit them. Already open clients can each show the change once.
There is no cross-client delivery coordination. Storage or notification failures leave
normal alias resolution working; persistence and notification delivery are best effort.

## Limitations

- Only the `latest` strategy exists; other strategies are rejected at startup.
- Aliases don't chain: each resolves against the fresh source catalog only, never against
  another alias.
- The plugin never fetches external catalogs; it only reacts to OpenCode's own model
  catalog refreshes.

## Development

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm run verify        # lint + typecheck + tests + build (self-contained)
pnpm run check:release # offline release checks; run after verify before opening a PR
```

CI verifies Node.js 22 and 24, plus the minimum supported OpenCode **2.0.16** and the
current pinned host **2.0.24**. Both host jobs load the packed npm artifact, verify the
concrete wire model against a local fake provider, and inspect through the real RPC
without model calls. Inspection also verifies native history across host restarts.
Run locally with an installed OpenCode v2 CLI: `pnpm smoke:opencode` and
`pnpm smoke:inspect`. These are separate from the self-contained `pnpm verify` checks.

MIT License — see [LICENSE](LICENSE).
