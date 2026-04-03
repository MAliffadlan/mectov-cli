# Mectov CLI

Local-first CLI for reading, searching, reviewing, and experimenting on a codebase, built on top of a public Claude Code source snapshot used here for research and tooling exploration.

> This repository is not an official Anthropic repository. The original Claude Code source remains Anthropic's property. This repo is a research archive plus a local experimental CLI layer called `Mectov`.

## What This Repo Is

This project currently has two layers:

1. `src/`
   A mirrored TypeScript source snapshot of Claude Code, kept here for architecture study, defensive security research, and agent-tooling analysis.

2. `mectov` + `scripts/local-experiment-cli.mjs`
   A standalone local CLI bootstrap that makes the repo directly usable without depending on Anthropic auth, internal services, or the original build pipeline.

If you open this repo and want something you can actually run today, `Mectov CLI` is the part you want.

## Why Mectov Exists

The original snapshot is large and tightly coupled to:

- Bun-specific build paths
- feature flags
- auth and account flows
- analytics and remote settings
- internal service integrations
- IDE bridge and remote session plumbing

That makes the raw snapshot interesting to study, but awkward to use as a local tool out of the box.

`Mectov` solves that by giving this repo a practical local runtime with:

- plain-language commands
- repo-safe reads and search
- git-aware change inspection
- lightweight code review
- guarded file editing
- approval-gated shell execution

## Highlights

- Local-first CLI with no Anthropic login required
- Natural language routing like `jelasin folder ini` and `cek perubahan project ini`
- Read-only safe mode and edit-enabled research mode
- File and folder explanation with concise summaries
- Quick inspection and lightweight risk review
- Git working tree summaries for the current repo area
- Workflow planning with step-by-step execution
- Named local agents such as `explorer`, `reviewer`, and `maintainer`
- File backups, diff, restore, and patch-based editing

## Quick Start

Run from the repo root:

```bash
node scripts/local-experiment-cli.mjs
```

Or use the repo launcher:

```bash
./mectov
```

To install `mectov` as a user command:

```bash
bash scripts/install-mectov.sh
```

## First Things To Try

After `mectov` opens, you can type normal language instead of memorizing commands.

Examples:

```text
jelasin folder ini
buka README.md
cari "agent" di src/tools
cek perubahan project ini
review scripts/local-experiment-cli.mjs
inspect src/tools/AgentTool
```

If you want the built-in guide:

```text
menu
```

## Modes

### `safe-local`

Read/search only.

```bash
./mectov --preset safe-local
```

Best for:

- exploring a repo
- reading files
- searching symbols
- reviewing changes
- understanding structure

### `research-local`

Read/search/edit/run with confirmations.

```bash
./mectov --preset research-local
```

Best for:

- patching files
- appending or writing content
- restoring backups
- running shell commands with approval

## Most Useful Commands

### Understand

- `explain [path]`
- `summary [path]`
- `inspect [path]`
- `tree [path] [depth]`
- `read <file> [start] [end]`

### Search

- `find <text> [path]`
- `grep <text> [path]`

### Review

- `changes [path]`
- `review [path]`
- `diff <file>`

### Workflow

- `plan <request>`
- `ask <request>`
- `think <request>`
- `solve <request>`
- `preview <request>`

### Editing

- `patch <file> <old> <new>`
- `patch-block <file> <old> <new>`
- `patch-lines <file> <start> <end> <new>`
- `patch-anchor <file> <anchor> <old> <new>`
- `write <file> [text]`
- `append <file> [text]`
- `replace <file> [old] [new]`
- `restore <file>`

### Session

- `status`
- `recap [lines]`
- `memory [lines]`
- `agents`
- `agent <name> <request>`
- `agent-memory <name> [lines]`

## What `explain`, `inspect`, `changes`, and `review` Do

### `explain`

Gives a human-readable summary of a file or folder using:

- file/folder structure
- top code signals
- current git context
- quick review hotspots

Example:

```text
jelasin scripts/local-agents.mjs
```

### `inspect`

Shows richer metadata and heuristics such as:

- line count
- import/export counts
- declaration names
- quick signal markers

Example:

```text
inspect scripts/local-experiment-cli.mjs
```

### `changes`

Summarizes git working tree state for a target area:

- changed files
- staged / unstaged / untracked counts
- diff stat

Example:

```text
cek perubahan project ini
```

### `review`

Runs a lightweight heuristic review for quick hotspots, including markers like:

- child process execution
- `shell: true`
- filesystem mutation
- `process.env`
- `TODO` / `FIXME` / `HACK`

Example:

```text
review .
```

## Local Agents

`Mectov` includes lightweight local personas that bias workflow planning:

- `generalist`
- `explorer`
- `reviewer`
- `maintainer`
- `editor`
- `statusline-helper`

Example:

```text
agent maintainer inspect scripts/local-experiment-cli.mjs
```

## Editing Model

Mutating actions are intentionally guarded.

Safety features include:

- workspace-scoped file access
- automatic backups under `.local-experiment/backups/`
- preview before mutating workflow steps
- exact-match patching as the preferred edit primitive
- approval checkpoints before writes and shell execution

For scripted runs where you explicitly want approvals skipped:

```bash
./mectov --preset research-local --yes
```

## Repo Layout

```text
.
├── mectov                          # repo-local launcher
├── scripts/
│   ├── local-experiment-cli.mjs    # main Mectov CLI entrypoint
│   ├── local-tool-registry.mjs     # tool definitions and routing hints
│   ├── local-model-adapter.mjs     # heuristic workflow builder
│   ├── local-model-runtime.mjs     # adapter runtime and fallback logic
│   ├── local-agents.mjs            # local agent personas
│   └── install-mectov.sh           # user command installer
├── docs/
│   └── local-experiment-cli.md     # detailed Mectov usage guide
└── src/                            # Claude Code source snapshot for research
```

## About The Source Snapshot

The `src/` directory is kept for research and architecture study.

High-level characteristics:

- language: TypeScript
- runtime: Bun
- UI: React + Ink
- includes command, tool, bridge, service, plugin, and agent subsystems

Interesting top-level areas inside `src/`:

- `src/main.tsx`
- `src/commands.ts`
- `src/tools.ts`
- `src/QueryEngine.ts`
- `src/tools/`
- `src/commands/`
- `src/components/`
- `src/services/`
- `src/bridge/`

## Documentation

- Detailed CLI guide: [docs/local-experiment-cli.md](docs/local-experiment-cli.md)

## Research And Ownership Note

- This repository is maintained for educational and defensive security research.
- It studies source exposure, packaging failures, and agentic CLI architecture.
- It is not affiliated with or endorsed by Anthropic.
- The mirrored Claude Code source snapshot is included for analysis, not ownership claims.
