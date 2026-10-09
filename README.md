# opencode-model-aliases

[![npm version](https://img.shields.io/npm/v/opencode-model-aliases.svg)](https://www.npmjs.com/package/opencode-model-aliases)
[![CI](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml/badge.svg)](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Model IDs go stale: previews get promoted, point releases land, and the IDs pinned in your
agents keep pointing at last month's model. This [OpenCode](https://opencode.ai) v2 plugin
adds **floating aliases** to the model catalog: a stable ID such as `opencode/zen-plan` that
always resolves to the newest model matching your rules.

## Concrete IDs vs aliases

Use a concrete model ID (`github-copilot/claude-sonnet-4.5`) to **pin** one model you want to
review and change yourself; OpenCode resolves it natively, no plugin needed. An alias earns
its keep when you mean a **policy**, not a model: "the newest free model with tools and a
large context", "the current Sonnet, whichever point release it is". The policy outlives the
model list; the alias keeps resolving to whatever the catalog says satisfies it today, and
the winner is allowed to move.

## Quick start

Add the plugin and one alias to `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-model-aliases@latest",
      "options": {
        "aliases": {
          "github-copilot/claude-sonnet": { "match": "github-copilot/claude-sonnet-*" }
        }
      }
    }
  ]
}
```

Run `/model-aliases` to see what each alias resolved to, then select
`github-copilot/claude-sonnet` like any other model; requests go to the real winning model.

> OpenCode caches plugin packages. Update with
> `opencode plugin update opencode-model-aliases@latest`; restarting alone won't.

## Examples

Each alias key is `<provider>/<alias-id>`. Every pattern must use the same literal provider
as its key: an alias never selects a model from another provider.

**Follow a family** and **skip previews or a specific model** with `exclude`:

```json
"openai/gpt-sol":  { "match": "openai/gpt-*-sol" },
"openai/gpt-luna": { "match": "openai/gpt-*-luna" },
"openai/latest": {
  "match": ["openai/gpt-*", "openai/o*"],
  "exclude": ["openai/*-preview", "openai/gpt-6.1-sol-pro"]
}
```

**Require capabilities** — tools, image input, large context:

```json
"github-copilot/vision": {
  "match": "github-copilot/gemini-*-flash",
  "filter": {
    "capabilities": { "tools": true, "input": ["image"], "output": ["text"] },
    "minContext": 128000
  }
}
```

**Pick a model per job**: "the best free model for planning" is a policy, not a model ID.
Filter the free set by what each job needs, then point agents at the aliases:

```json
{
  "plugins": [{
    "package": "opencode-model-aliases@latest",
    "options": {
      "aliases": {
        "opencode/zen-plan": {
          "match": ["opencode/*-free", "opencode/big-pickle"],
          "filter": { "capabilities": { "tools": true }, "minContext": 256000 },
          "name": "Zen Free — Plan"
        },
        "opencode/zen-build": {
          "match": ["opencode/*-free", "opencode/big-pickle"],
          "filter": {
            "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
            "minContext": 64000
          },
          "name": "Zen Free — Build"
        }
      }
    }
  }],
  "agents": {
    "plan":  { "model": "opencode/zen-plan" },
    "build": { "model": "opencode/zen-build" }
  }
}
```

Filters decide **eligibility**, not quality. If several models qualify, the newest wins, so
both aliases may currently pick the same model. `*-free` is a naming convention, not a price
check, and free offers can change.

Only `active` models are eligible by default; opt into others explicitly:

```json
"openai/bleeding-edge": {
  "match": "openai/gpt-*",
  "filter": { "status": ["active", "alpha", "beta"] }
}
```

## How a winner is picked

When the plugin starts and at every catalog refresh, each alias:

1. **Matches** models with `match`, then removes `exclude` matches
   ([picomatch](https://github.com/micromatch/picomatch) globs).
2. **Filters** by `enabled`, status, capabilities and `minContext`. All filters must pass;
   missing metadata fails the filter that needs it.
3. **Selects** the newest `time.released`. Ties use the descending model ID
   (`gpt-6.1-sol-pro` beats `gpt-6.1-sol-fast`). Models without release dates never win.

Selection is deterministic: same catalog, same rules, same winner. The alias gets a copy of
the winner's model info under the alias ID; aliases never select other aliases, and
declaration order doesn't matter.

## Options

| Option | Default | Notes |
|---|---|---|
| `aliases` | required | Object of aliases; `{}` is valid. |
| `strict` | `false` | Fail startup if any alias doesn't resolve. |
| `debug` | `false` | Log each resolution as a `[debug]` warning. |
| `match` | required | Glob or list of globs: `"provider/pattern"`. |
| `exclude` | none | Same format as `match`. |
| `filter.status` | `["active"]` | Any of `active`, `alpha`, `beta`. |
| `filter.capabilities` | none | `tools` (boolean), `input`/`output` (all listed modalities required). |
| `filter.minContext` | none | Minimum context window, inclusive. |
| `name` | generated | Display name. Without it, `sonnet` becomes `Sonnet (alias)`. |
| `select` | `latest` | Only `{ "strategy": "latest" }` is supported. |

Aliases can also live in `.opencode/opencode-model-aliases.jsonc` (JSONC comments and
trailing commas are fine); the plugin uses the nearest file found from the working directory
upward. Inline options win: an inline alias replaces a file alias with the same key, and
inline `strict`/`debug` values win. Inline options apply when OpenCode reloads its
configuration; the `.jsonc` file is read at plugin start, so restart after editing it.

For editor autocompletion and shape validation, `schema.json` ships with the package as a
draft-07 JSON Schema; point the config file's `$schema` at it (file-only metadata: editors
may require it, the plugin strips it before merging, and inline plugin options never accept
it). The schema checks shape only — glob compilation, the literal-provider rule and provider
equality are still enforced by the plugin at runtime, which remains authoritative.

```jsonc
// .opencode/opencode-model-aliases.jsonc — complete example
{
  "$schema": "https://raw.githubusercontent.com/vmvarela/opencode-model-aliases/v0.4.0/schema.json",
  "strict": true,
  "aliases": {
    "openai/latest": {
      "match": ["openai/gpt-*", "openai/o*"],
      "exclude": ["openai/*-preview"],
      "filter": { "minContext": 128000 }
    }
  }
}
```

## Seeing what aliases resolved to

Run `/model-aliases` (or **Model aliases** in the command palette) for the current target and
the real model ID used for requests, with unresolved reasons where a selection failed. Run
`/model-aliases explain <provider>/<alias-id>` for the full decision: matching patterns,
rejected candidates with their reasons, and whether the runner-up lost on release date or the
descending model-ID tie-break. Nothing here calls a model. In OpenCode 2.0.22, selecting the
slash suggestion leaves a trailing space; press Enter again. Without a TUI:

```sh
opencode api --standalone post /api/rpc/opencode-model-aliases/inspect --data '{"input":{}}'
```

The backend also exposes [`explain({ alias })`](https://github.com/vmvarela/opencode-model-aliases/issues/24)
on the same `opencode-model-aliases` RPC.
Explanation reflects the catalog visible to the plugin's transform; models disabled with
`disabled: true` are still invisible to it, and in strict mode a startup failure prevents
the plugin and its RPC from becoming available.

**[Change visibility](https://github.com/vmvarela/opencode-model-aliases/issues/38).** The first resolution sets a silent baseline. When an alias later
changes target, the TUI shows a toast and `/model-aliases` shows the previous target, the
current target and when the change was detected. Editing an alias's `match` or `filter`
rules resets its baseline: a changed alias is a config change you should see, not hunt for
in logs.

**Plugin ordering — verified facts only.** The plugin resolves against the fresh catalog it
receives and observes later `model.updated` refreshes from there. Verified behaviors: the
inspect report is built from a fresh source catalog, and a downstream rewrite of the alias
`modelID` by another plugin can make the report return `unavailable`, because the rewritten
catalog no longer matches what the alias materialized. No other multi-plugin ordering
guarantees are documented; don't rely on plugin execution order.

## Limits, failure and non-goals

- Invalid configuration (including unknown keys and invalid globs) and an alias that would
  overwrite a real model both fail at startup.
- An alias with no candidate logs a warning and is left out; other aliases keep working.
  With `strict: true`, startup fails instead. If a target disappears later, the alias
  disappears until a matching model returns.
- Only the `latest` strategy exists. The plugin can't rank by price or quality.
- Aliases are provider-isolated and never chain.
- The plugin only reads OpenCode's catalog; it never fetches external model lists.
- Models hidden with `disabled: true` in your OpenCode provider config can still be selected
  by an alias ([#42](https://github.com/vmvarela/opencode-model-aliases/issues/42)). Use
  `exclude` to keep a model out of an alias.
- Compatibility is verified only for OpenCode **2.0.16 and 2.0.24** ([real-host smoke
  tests in CI](.github/workflows/ci.yml), tracked in [#29](https://github.com/vmvarela/opencode-model-aliases/issues/29)); other host versions are not on the verified matrix.

Explicitly out of scope: prompt classification ("which prompt needs which model"), smart
routing, provider proxying, credential management, retries/failover, billing, and session
orchestration. Aliases adapt selection as the catalog changes; what happens to a request
once it leaves the plugin is OpenCode's job.

## The 1.0 line

v1.0 means: reliable selection from a valid catalog, config that fails loudly and early,
changes that are visible without digging through logs, and verified compatibility with the
host versions above. The `latest` strategy alone is sufficient for that; stability comes
from determinism and diagnostics, not from more selection policies. Backlog ideas remain
outside 1.0 scope; no additional selection strategy is required for this release.

## Development

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm run verify          # lint, typecheck, tests and build
pnpm run check:release   # offline release checks
pnpm smoke:opencode      # optional; needs an installed OpenCode v2 CLI
```

MIT License — see [LICENSE](LICENSE).
