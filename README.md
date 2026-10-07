# opencode-model-aliases

[![npm version](https://img.shields.io/npm/v/opencode-model-aliases.svg)](https://www.npmjs.com/package/opencode-model-aliases)
[![CI](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml/badge.svg)](https://github.com/vmvarela/opencode-model-aliases/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Stop hardcoding model versions in your OpenCode config.**

Model IDs go stale. Sonnet gets point releases, previews get promoted, and the IDs pinned
in your agents keep pointing at last month's model. This [OpenCode](https://opencode.ai) v2
plugin adds **floating aliases** to the model catalog: a stable ID such as
`opencode/zen-plan` that always resolves to the newest model matching your rules.

Use a concrete model ID when you want to pin a model. Use an alias when you want to follow a
family, or "the newest model that can do this job".

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

Run `/model-aliases` to see what each alias resolved to. Select `github-copilot/claude-sonnet`
like any other model; requests go to the real winning model.

> OpenCode caches plugin packages. Update with
> `opencode plugin update opencode-model-aliases@latest`; restarting alone won't.

## Examples

Each alias key is `<provider>/<alias-id>`. Every pattern must use the same literal provider
as its key: an alias never selects a model from another provider.

### Follow a model family

Track the newest model in each family:

```json
"openai/gpt-sol":  { "match": "openai/gpt-*-sol" },
"openai/gpt-luna": { "match": "openai/gpt-*-luna" }
```

### Skip previews or a specific model

Use `exclude` to keep previews out, or to avoid one model you don't want:

```json
"openai/latest": {
  "match": ["openai/gpt-*", "openai/o*"],
  "exclude": ["openai/*-preview", "openai/gpt-6.1-sol-pro"]
}
```

### Require capabilities

Choose only models with tools, image input and a large context window:

```json
"github-copilot/vision": {
  "match": "github-copilot/gemini-*-flash",
  "filter": {
    "capabilities": { "tools": true, "input": ["image"], "output": ["text"] },
    "minContext": 128000
  }
}
```

### Pick a model per job

"The best free model for planning" is a policy, not a model ID. Filter the free set by what
each job needs, then point agents at the aliases:

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

### Allow alpha or beta models

Only `active` models are eligible by default. Opt in explicitly:

```json
"openai/bleeding-edge": {
  "match": "openai/gpt-*",
  "filter": { "status": ["active", "alpha", "beta"] }
}
```

## How a winner is picked

At every catalog refresh, each alias:

1. **Matches** models with `match`, then removes `exclude` matches. Patterns are
   [picomatch](https://github.com/micromatch/picomatch) globs.
2. **Filters** by `enabled`, status, capabilities and `minContext`. All filters must pass;
   missing metadata fails the filter that needs it.
3. **Selects** the newest `time.released`. Ties use the descending model ID
   (`gpt-6.1-sol-pro` beats `gpt-6.1-sol-fast`). Models without release dates never win.

The alias gets a copy of the winner's model info under the alias ID. Aliases never select
other aliases, and declaration order doesn't matter.

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

Aliases can also live in `.opencode/opencode-model-aliases.jsonc`. The plugin uses the
nearest file found from the working directory upward. Inline options win: an inline alias
replaces a file alias with the same key, and inline `strict`/`debug` values win. Changes to
inline options apply when OpenCode reloads its configuration. The `.jsonc` file is read when
the plugin starts, so restart OpenCode after editing it.

## When things fail

- **Invalid configuration fails at startup**, including unknown keys and invalid globs.
- **An alias that would overwrite a real model fails at startup.**
- **An alias with no candidate** logs a warning and is left out; other aliases keep working.
  With `strict: true`, startup fails instead.
- If a target disappears later, the alias disappears until a matching model returns.

## Inspecting aliases

Run `/model-aliases`, or choose **Model aliases** from the command palette. It shows each
target, unresolved reasons and the real model ID used for requests. It never calls a model.
In OpenCode 2.0.22, selecting the slash suggestion leaves a trailing space; press Enter again.

Without a TUI:

```sh
opencode api --standalone post /api/rpc/opencode-model-aliases/inspect --data '{"input":{}}'
```

The first resolution sets a silent baseline. When an alias later changes target, the TUI shows
a toast and `/model-aliases` shows the previous target, the current target and when the change
was detected. Changing an alias's match or filter rules resets its baseline.

## Limitations

- Only the `latest` strategy exists. The plugin can't rank by price or quality.
- Aliases are provider-isolated and never chain.
- The plugin only reads OpenCode's catalog; it never fetches external model lists.

## Development

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm run verify          # lint, typecheck, tests and build
pnpm run check:release   # offline release checks
pnpm smoke:opencode      # optional; needs an installed OpenCode v2 CLI
```

MIT License — see [LICENSE](LICENSE).
