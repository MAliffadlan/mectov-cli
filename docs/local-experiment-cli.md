# Mectov CLI

This repo snapshot does not currently include the original build metadata such as `package.json` or `tsconfig.json`, so the fastest path to a usable local tool is a standalone bootstrap that does not depend on Anthropic services.

The new entrypoint is:

`node scripts/local-experiment-cli.mjs`

For a simpler repo-local launcher, use:

`./mectov`

To install `mectov` as a user command:

`bash scripts/install-mectov.sh`

You can also point it at another workspace root:

`node scripts/local-experiment-cli.mjs --root /path/to/project`

Preset behavior:

- `node scripts/local-experiment-cli.mjs --preset safe-local`
- `node scripts/local-experiment-cli.mjs --preset research-local`
- `./mectov --preset safe-local`
- `./mectov --preset research-local`

For scripted runs, you can auto-approve confirmations:

`node scripts/local-experiment-cli.mjs --preset research-local --yes`

## What it does today

- keeps all file access inside the selected workspace root
- logs each session under `.local-experiment/sessions/`
- stores file backups under `.local-experiment/backups/` before edits
- exposes a local tool registry plus a lightweight planner for routing natural-language requests
- stores workflow memory under `.local-experiment/workflow-memory.jsonl`
- stores per-agent memory under `.local-experiment/agents/`
- gives you safe local commands for browsing, reading, searching, diffing, restoring, editing, and running shell commands with confirmation

## Commands

- `help`
- `tools`
- `adapter`
- `agents`
- `agent <name> <request>`
- `agent-memory <name> [lines]`
- `mode`
- `status`
- `plan <request>`
- `ask <request>`
- `think <request>`
- `solve <request>`
- `preview <request>`
- `memory [lines]`
- `recap [lines]`
- `pwd`
- `summary [path]`
- `ls [path]`
- `tree [path] [depth]`
- `read <file> [start] [end]`
- `find <text> [path]`
- `grep <text> [path]`
- `diff <file>`
- `restore <file>`
- `patch <file> <old> <new>`
- `patch-block <file> <old> <new>`
- `patch-lines <file> <start> <end> <new>`
- `patch-anchor <file> <anchor> <old> <new>`
- `write <file> [inline text]`
- `append <file> [inline text]`
- `replace <file> [old] [new]`
- `run <shell command>`
- `history [lines]`
- `quit`

Commands also accept a slash prefix, so `/read README.md 1 20` works too.

`ask` will auto-run the selected action when it resolves to a read-only tool with a confident command. Low-confidence workflows will not auto-run through `ask`. For write or shell actions, it prints the routing result and leaves execution to you.

`think` builds a multi-step workflow for broader requests. `solve` runs that workflow automatically when every step is enabled. Read-only steps run immediately; mutating steps show a preview and then ask for approval one by one. `preview` shows the workflow plus previews for mutating steps without executing them. `memory` shows recent stored workflows.

`status` prints the current session counters. `recap` prints a compact transcript summary with recent commands and actions. In TTY mode the prompt also acts like a mini statusline, showing the preset plus command, workflow, edit, and error counters.

`adapter` shows the active planner backend. By default Mectov uses the built-in heuristic planner. You can also switch to a local module adapter:

`./mectov --adapter module --adapter-command /absolute/path/to/adapter.mjs`

The module should export either `default(payload)` or `planWorkflow(payload)` and return an object with:

- `intent`
- `summary`
- `steps`
- optional `notes`
- optional `confidence`
- optional `rationale`
- optional `phases`

`phases` can describe grouped workflow sections and refer to one-based step numbers. An example lives at `scripts/example-module-adapter.mjs`.

When an adapter returns this richer metadata, `think`, `solve`, `agent`, `memory`, and `agent-memory` will show it directly in the CLI.

Confidence policy:

- `high`: normal read-only auto-run behavior
- `medium`: allowed, but Mectov prints an extra caution note
- `low`: `ask` will not auto-run, and `solve` requires an extra workflow-level confirmation unless you explicitly pass `--yes`

`external-command` is also supported for advanced setups through `--adapter external-command --adapter-command 'your command here'`, but that path depends more on the local runtime environment.

`patch` is the safer edit primitive: it requires exactly one match in the target file before applying the change. `patch-block` does the same for multi-line text using escaped values like `\n` and `\t`. `patch-lines` targets an exact line range. `patch-anchor` targets one exact match inside a unique nearby anchor block. `replace` still exists when you intentionally want a broader substitution.

Example anchor patch:

`patch-anchor app.txt "section a\\nTODO\\nend a" TODO DONE`

`agent` runs the same workflow system through named local personas:

- `generalist`: balanced default behavior
- `explorer`: favors structure and symbol tracing
- `reviewer`: favors evidence gathering and issue-oriented inspection
- `editor`: favors file changes plus post-edit verification
- `statusline-helper`: biases toward prompt and statusline related searches

For mutating workflows in scripted mode, use `--preset research-local --yes`.

## Why this is the right first step

The original snapshot is heavily tied to Bun feature flags, UI layers, auth, analytics, remote session plumbing, and internal service calls. Starting from `src/main.tsx` is possible later, but it is not the shortest route to a usable local CLI.

This bootstrap gives the repo an immediate local workflow while we peel back the larger app in controlled stages.

## Next phases

1. Reuse selected source modules from `src/tools/` once their dependencies are isolated.
2. Let confidence shape more nuanced behavior, like stricter gating for mutating plans than for read-only plans.
3. Add transcript-aware summaries or compact review modes for longer sessions.
4. Explore a richer full-screen terminal UI once the local workflows stabilize.
