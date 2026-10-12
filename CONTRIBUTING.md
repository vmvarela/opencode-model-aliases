# Contributing

## Setup

- Node.js 22+ and pnpm 11 (see `engines` / `packageManager` in `package.json`).
- Install dependencies: `pnpm install`.
- Run the full validation suite: `pnpm run verify` (lint, typecheck, tests, build).
- Optional, offline release checks: `pnpm run check:release`.
- Optional, against a locally installed OpenCode v2 CLI: `pnpm run smoke:opencode`.

## Preferences

- Keep changes focused; don't mix unrelated edits.
- If the TUI changes, include real screenshots (taken with OpenCode) in the PR or issue.
- Bug reports and feature requests go through the GitHub issue templates.
