# Stable model references in OMO-slim presets

An OMO-slim preset can refer to a floating alias instead of a particular model generation.
Model selection stays provider-local and uses release metadata from OpenCode's catalog.

Load the alias plugin before OMO-slim in `opencode.json`:

```json
{
  "plugins": [
    { "package": "opencode-model-aliases@latest" },
    { "package": "oh-my-opencode-slim@latest" }
  ]
}
```

Define the policy in `.opencode/opencode-model-aliases.jsonc`:

```jsonc
{
  "aliases": {
    "opencode-go/glm-latest": {
      "match": "opencode-go/glm-*",
      "filter": { "capabilities": { "tools": true } }
    },
    "opencode-go/kimi-code-latest": {
      "match": "opencode-go/kimi-*-code",
      "filter": { "capabilities": { "tools": true } }
    }
  }
}
```

Use the full `provider/alias` references in your OMO-slim configuration:

```json
{
  "preset": "floating-go",
  "presets": {
    "floating-go": {
      "orchestrator": { "model": "opencode-go/glm-latest" },
      "fixer": { "model": "opencode-go/kimi-code-latest" }
    }
  }
}
```

Merge these entries into your existing preset and keep the other agent settings.
Check `opencode models --refresh` for the provider and model IDs available to your account,
then restart and inspect `/model-aliases`. Patterns must match real catalog entries:
the plugin cannot discover missing providers or models. Variant availability comes from
the selected model; a floating alias does not guarantee that a particular variant exists.

When a later catalog refresh changes an eligible target, the alias ID stays the same and
the plugin records the transition. This complements OMO-slim's orchestration and preset
switching; it does not implement retries, failover or model routing.

Upstream configuration: [OMO-slim presets](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/configuration.md).
