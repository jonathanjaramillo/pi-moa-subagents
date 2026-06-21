# pi-moa-subagents

Mixture-of-experts bug diagnosis for Pi. Point multiple models at a bug, have each investigate independently, then synthesize findings into an executive summary or an implemented-and-tested fix.

## Prerequisites

This extension requires [pi-subagents](https://github.com/nicobailon/pi-subagents). Install it first:

```bash
pi install npm:pi-subagents
```

`pi-moa-subagents` does not bundle pi-subagents — it uses its `subagent` tool as the execution engine. If you try to run `/moa-subagents` without it, you'll get a clear error with installation instructions.

## Installation

```bash
pi install npm:pi-moa-subagents
```

Or install from a local path during development:

```bash
pi install /absolute/path/to/pi-moa-subagents
```

## How It Works

1. You describe the bug (inline or multi-line editor).
2. You select 1+ **investigator models** (multi-select) — each gets run sequentially via subagent `concurrency: 1` to respect single-GPU VRAM limits. Investigators are read-only by instruction (tools: `read`, `grep`, `find`, `bash`).
3. You pick a **synthesis model** (single select) that consolidates findings.
4. You choose **summary-only** or **auto-implement-and-test**.

Investigators write reports to `diagnose/<timestamp>/` as `.md` files. The synthesis step reads these and either:

- **Summary mode**: Produces root cause, confidence, evidence per model, and a recommended fix direction. Nothing is changed in the codebase.
- **Implement mode**: Hands off to the built-in `worker` agent with an acceptance contract requiring tests to pass before finishing.

## Usage

### With inline description

```
/moa-subagents The login form crashes when a user enters special characters in the email field
```

### With multi-line editor (bare invocation)

```
/moa-subagents
```

Opens a text editor for a detailed bug description including steps to reproduce, expected vs. actual behavior, etc.

## Architecture Notes

- **Sequential model loading.** Uses `concurrency: 1` on the investigator batch — models run one at a time so only one local model occupies VRAM at once.
- **Investigators are read-only by instruction.** The `investigator` agent has `read`, `grep`, `find`, and `bash` tools (no `edit`/`write`), plus an explicit system prompt not to modify files. Since `bash` is included, a model could technically write via shell redirection if it ignored instructions — this is enforced by convention, not hard sandboxing.
- **Agent file.** The `investigator.md` agent definition ships in the package source and is copied to `~/.pi/agent/agents/investigator.md` (or `$PI_CODING_AGENT_DIR/agents/`) on first session start. Existing customizations at that path are never overwritten.

## License

MIT
