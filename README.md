# Pi Extensions

Six independent extensions for [Pi](https://pi.dev), covering Git commands, task progress, PhpStorm MCP integration for pi acp, search-output filtering, and quitting a session.
Enable only the extensions needed, or use all six together.

## Extensions at a glance

| Extension | Entry point | What it adds |
| --- | --- | --- |
| [Exit](#exit) | `exit.ts` | `/exit` to request a normal Pi shutdown. |
| [Git](#git) | `git/index.ts` | `/git` to run Git commands and aliases in an interactive terminal without a model call. |
| [WIP](#wip) | `wip.ts` | `/wip` to stage changes under the current directory and commit with the message `wip`. |
| [PhpStorm MCP integration for pi acp](#phpstorm-mcp-integration-for-pi-acp) | `phpstorm-mcp/index.ts` | Connects pi acp to PhpStorm's MCP server through RPC-only registration. |
| [Progress](#progress) | `progress/index.ts` | Opt-in, persistent task tracking with background model updates and a standalone CLI. |
| [RTK for ffgrep](#rtk-for-ffgrep) | `rtk-ffgrep/index.ts` | Filters large `ffgrep` results through RTK while preserving access to the original output. |

## Installation

Pi's Git-package method installs from the repository root, not from individual extension subdirectories.
**This repository currently lacks the required root `package.json` declaring the six entry points under `pi.extensions`.**
Once that manifest is added, install the package and select which extensions load:

```sh
pi install git:github.com/zaherg/pi-extensions
pi config
```

Run `/reload` or restart Pi after changing the selection.
Restart an existing ACP/RPC session after installing or configuring PhpStorm MCP.

The syntax `git:github.com/zaherg/pi-extensions/<extension-name>` does not select an extension subdirectory in Pi 1.5.0.
For example, Pi treats `git:github.com/zaherg/pi-extensions/git` as a complete repository URL and passes it to Git, rather than selecting `git/` within this repository.

Installing the package does not install RTK, provide `ffgrep`, configure PhpStorm, or enable task tracking.
Complete the relevant setup below before using those features.
Extensions run with the same permissions as Pi; review the source before installing.

## Exit

```text
/exit
```

Calls Pi's `ctx.shutdown()` to request a normal shutdown rather than terminating the process directly.
Registered shutdown handlers can finish their work, including an enabled Progress updater waiting for a pending save.
There are no settings and no model call.

## Git

```text
/git status
/git add -p
/git diff --cached
/git commit "Fix validation"
/git log --oneline -10
```

`/git` runs the supplied command in Pi's current working directory through `$SHELL`, falling back to `/bin/sh`.
It suspends Pi's interface and gives Git a pseudoterminal, so editors, pagers, credential prompts, and interactive staging can work normally.
Run it while the agent is idle; non-interactive Pi modes are refused.

A standalone `/git commit "message"` or `/git commit 'message'` becomes `git commit -m ...`.
It commits the existing index without automatically staging files.
For flags or pathspecs, use native syntax such as `/git commit -m "Fix validation" --amend`.

All installed Git subcommands and Git aliases are passed through, not restricted to a whitelist.
The arguments are shell code: expansions, pipes, redirects, and chained commands are allowed.
Run only trusted input; destructive commands and Git hooks execute without an additional confirmation.

- Successful commands wait for Enter before returning to Pi.
- Failed commands return automatically and display a bounded, sanitized tail of Git's diagnostic output.
- Ctrl+C interrupts the foreground command without closing Pi.
  It does not undo changes already made.
- No model call is made, and captured output is not inserted into model context or saved session messages.
  Terminal scrollback and Pi input history can still retain input or output.

See [Git details](git/README.md) for shell behavior, output limits, and redaction caveats.

## WIP

```text
/wip
```

Runs these commands sequentially in Pi's current working directory, without a model call:

```sh
git add .
git commit -m "wip"
```

Unlike `/git commit`, **`/wip` automatically stages changes**, including untracked files not excluded by Git's ignore rules.
Run it from the repository root to stage changes across that repository, or from a subdirectory to stage changes under that directory.
The commit also includes anything already staged elsewhere in the repository.
Review the working tree and index first, especially for secrets or unrelated work.

The command accepts no arguments and does not push.
If staging fails, no commit is attempted.
If committing fails, staged changes remain; check Git status before retrying.
Failures report the operation and exit status rather than forwarding raw hook output into Pi.

## PhpStorm MCP integration for pi acp

Connects pi acp sessions in PhpStorm to the IDE's MCP tools without connecting ordinary Pi terminal sessions to the IDE.
It is a registration adapter, not an MCP server or an ACP client.

At `session_start`, the extension checks `ctx.mode`.
Only RPC sessions read the configuration and register the session-scoped server named `phpstorm` through Pi's built-in MCP support.
TUI, print, and JSON sessions do neither.
The check applies to every RPC client, not only JetBrains; it does not detect whether PhpStorm is running.

### Setup

1. Enable and start PhpStorm's MCP server in the IDE.
2. Keep Pi's built-in MCP support enabled.
3. Configure a `pi-acp` agent in JetBrains separately; this extension does not install `pi-acp`.
4. Create `~/.pi/agent/pi-phpstorm-mcp.json` using the command, arguments, and port supplied by PhpStorm's MCP settings.
5. Restart the ACP/RPC session.

The file contains one server configuration object, **without an `mcpServers` wrapper**.
For example, adapt this macOS configuration to the actual installation:

```json
{
  "type": "stdio",
  "env": {
    "IJ_MCP_SERVER_PORT": "64442"
  },
  "command": "/absolute/path/to/PhpStorm.app/Contents/MacOS/phpstorm",
  "args": ["stdioMcpServer"]
}
```

Do not rely on the missing-file defaults: they use the original author's `/Users/zaher/Applications/PhpStorm.app/Contents/MacOS/phpstorm` path and port `64442`.
An existing configuration replaces those defaults rather than merging with them.
Unreadable files or malformed JSON cause an error, not a fallback.

Do not also configure `phpstorm` in global or project `mcp.json` if it should remain RPC-only.
A file-configured server takes precedence and is not controlled by this extension's mode check.
See [PhpStorm MCP details](phpstorm-mcp/README.md) for configuration behavior and the separate standalone repository.

## Progress

Maintains tasks, agreed decisions, steps, blockers, and completion status across sessions or harnesses.
Installing it does not enable tracking; opt in from the project directory:

```text
/progress start
/progress
```

`/progress start` creates an empty record if none exists and preserves an existing record.
`/progress` reports the location and counts without enabling tracking.
The model-facing `progress` tool can read or explicitly correct records but cannot opt a project in.

### Storage and updates

Progress is stored as compact JSON at:

```text
~/.config/ai-sessions/<canonical-project-folder-name>/progress.json
```

The document records the full canonical project path, stable task and step IDs, and a revision.
Projects with the same folder name but different canonical paths are refused rather than sharing records.
Moving a project requires explicit handling; no migration is automatic.
Step status is `null` (not started), `working`, `blocked`, or `completed`, with a separate blocker field.

After a completed assistant reply, an `agent_settled` handler schedules a background model request without delaying the next input.
Validated patches are saved using an exclusive lock, expected-revision checks, and an atomic file replacement.
Omitted tasks and steps are preserved.
New input or session changes invalidate stale updates; graceful quit waits for pending work, subject to the model request's 60-second deadline.
A model-generated completion status is a record of reported evidence, not proof that work succeeded.

### Model configuration and privacy

The updater uses Pi's effective `defaultProvider` and `defaultModel`, not the current session model.
Both must be configured unless an override is supplied.
To select another registered model, merge this into `~/.pi/agent/settings.json`, replacing the placeholder, then run `/reload`:

```json
{
  "progress": {
    "model": "your-provider/your-model-id"
  }
}
```

The first slash separates provider from model ID.
There is no automatic fallback if the model or credentials are unavailable.
Errors leave saved progress unchanged and produce a warning.

**Tracking makes additional, billable model requests.**
The selected provider receives existing task records and a bounded selection of recent user text and completed assistant replies.
Hidden reasoning, raw tool arguments/results, and images are excluded.
Credential redaction is heuristic; do not treat it as a guarantee that sensitive text cannot be sent.
Usage is recorded in `progress-usage` session entries; the extension does not add these charges to Pi's normal session totals.

### Use from another harness

The standalone CLI reads one JSON request from stdin and does not require Pi to be running.
Replace `/path/to/pi-extensions` with the package's installed directory:

```sh
printf '%s\n' '{"action":"read"}' |
  node "/path/to/pi-extensions/progress/cli.ts" --cwd /path/to/project
```

Use the CLI or `progress` tool for writes, not direct edits to `progress.json`, so writers share validation and locking.
There is no `/progress stop` command.
To disable tracking while retaining history, stop all writers and move `progress.json` to a backup location.
See [Progress details](progress/README.md) for the full CLI protocol, concurrency rules, recovery, and privacy limits.

## RTK for ffgrep

An adapter for an existing `ffgrep` tool, not a search tool itself.
Install RTK separately, ensure `rtk` is on Pi's `PATH`, and enable an FFF integration that exposes `ffgrep`.
Pi's built-in `grep` is not a substitute for that tool name.
The adapter was verified against RTK 1.1.0 and Pi 1.5.0; other RTK protocol versions are not assumed compatible.

### Pipeline setup

Create `~/.config/rtk/pipeline.toml` with the following configuration.
If it already exists, merge the rule into the existing configuration rather than overwriting unrelated rules.

```toml
schema_version = 1

[pipeline]
name = "pi-ffgrep"
extends = "rtk:default"

[[hook.after_tool.any]]
name = "ffgrep-output"
use = ["ansi", "cap"]
```

Validate the pipeline:

```sh
RTK_CONFIG_DIR="$HOME/.config/rtk" rtk pipeline validate
RTK_CONFIG_DIR="$HOME/.config/rtk" rtk pipeline explain --agent pi --tool ffgrep
```

RTK 1.1 classifies unknown tools as `any`, so do not add `when = { tool = "ffgrep" }` to this rule.
The extension itself limits submissions to `ffgrep` results.

### How filtering works

On a successful, single-text-block `ffgrep` result, the extension sends JSON through stdin to `rtk hook claude`.
This is a local compatibility protocol, not a Claude or other model request.
The supplied pipeline strips terminal escapes and caps long output.

A replacement is accepted only if it is smaller, preserves file headings and notices, and provides a native recall hash whose `rtk recall --full` output exactly matches the original text.
Errors, structured or mixed results, unsupported responses, timeouts, or failed recall checks leave the original output intact.
Each RTK process has a two-second timeout and a two-MiB output limit.

Accepted text is shown in Pi, sent to the model as the tool result, and saved in the session.
The full original is recoverable through RTK's local recall storage.
The adapter sets `RTK_CONFIG_DIR` only for its child processes; it does not change the session environment or patch RTK, FFF, or another RTK extension.

To bypass filtering, start Pi with `RTK_DISABLED=1`, or set `enabled = false` on the pipeline rule.
Pipeline edits apply to subsequent calls; extension source changes require `/reload` or a restart.
See [RTK adapter details](rtk-ffgrep/README.md) for recall storage, compatibility checks, and limitations.

## Update or remove

After Git-package installation is available, use Pi to update installed packages:

```sh
pi update --extensions
```

Use `pi config` to disable individual extensions, or remove the entire package:

```sh
pi remove git:github.com/zaherg/pi-extensions
```

Run `/reload` or restart Pi afterward.
Removing the package does not delete saved progress, PhpStorm configuration, or RTK data.

## License

[MIT](LICENSE.md).
