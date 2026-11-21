# Pi Extensions

Nine independent extensions for [Pi](https://pi.dev), including Git commands, task progress, tool history, worker status, PhpStorm MCP integration for pi acp, and RTK filtering and savings.
Enable only the extensions needed.

## Extensions at a glance

| Extension | Entry point | What it adds |
| --- | --- | --- |
| [Exit](#exit) | `exit.ts` | `/exit` to request a normal Pi shutdown. |
| [Git](#git) | `git/index.ts` | `/git` to run Git commands and aliases with inline results, terminal access, and no model call. |
| [WIP](#wip) | `wip.ts` | `/wip` to stage changes under the current directory and commit with the message `wip`. |
| [PhpStorm MCP integration for pi acp](#phpstorm-mcp-integration-for-pi-acp) | `phpstorm-mcp/index.ts` | Connects pi acp to PhpStorm's MCP server in RPC mode only while PhpStorm is running. |
| [Progress](#progress) | `progress/index.ts` | Opt-in, persistent task tracking with background model updates and a standalone CLI. |
| [RTK for other Pi tools](#rtk-for-other-pi-tools) | `rtk-pi-extended/index.ts` | Filters Bash, search, and MCP results that RTK's own Pi hook misses, and reports Pi-specific coverage with `/rtk-coverage`. |
| [RTK gain](#rtk-gain) | `rtk-gain/index.ts` | Shows local RTK token savings in the footer and reports per-sandbox totals with `/rtk-gain all`. |
| [Trace](#trace) | `trace/index.ts` | `/trace failed bash` finds a recorded failure on the current branch without rerunning it. |
| [Worker board](#worker-board) | `worker-board/index.ts` | `/workers` shows assignments and reported outcomes from a compatible `subagent` runner. |

## Installation

Pi's Git-package method installs from the repository root, not from individual extension subdirectories.
The root `package.json` declares the extension entry points under `pi.extensions`.
Requires Node.js 22.19 or newer and Git.
Install the package and select which extensions load:

```sh
pi install git:github.com/zaherg/pi-extensions
pi config
```

The package is registered globally in `~/.pi/agent/settings.json`, with all extensions enabled by default.
Use `pi config` to disable those not needed.
No build step or manual `npm install` is required; Pi supplies the declared peer dependencies.
Remove or disable previous installations of the same extensions before reloading to avoid duplicate commands and tools.

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

- Commands return automatically without an Enter prompt and display a bounded, sanitized output tail inline.
- Failed commands include Git's diagnostic text and exit status.
- Ctrl+C interrupts the foreground command without closing Pi.
  It does not undo changes already made.
- Sanitized results are saved as display-only session entries, not model context.
  No model call is made.
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

At `session_start`, the extension checks `ctx.mode` and, for RPC sessions, whether PhpStorm is running locally.
Only RPC sessions with a running IDE read the configuration and register the session-scoped server named `phpstorm` through Pi's built-in MCP support.
A closed IDE is silently skipped; failed process queries report an error without registering.
TUI, print, and JSON sessions do not inspect applications, read configuration, or register the server.
The check applies to every RPC client, not only JetBrains; other ACP clients can still connect while PhpStorm is open.
It does not launch PhpStorm, poll for changes, or check MCP health.
Restart the ACP/RPC session after opening PhpStorm.

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
A file-configured server takes precedence and bypasses this extension's mode and running-application checks.
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

## RTK for other Pi tools

RTK's own Pi hook only rewrites Bash commands that have an RTK equivalent before they run.
This extension reduces, after they run, the results that hook never sees:

- Repeated `read` results become stubs naming the earlier tool call, as long as the model can still see it.
- Lockfiles, minified files, large truncated JSON, and logs, read with `read` or printed by Bash, get labelled non-code views.
- Bash commands RTK does not rewrite, such as scripts, `node`, `sed -n`, or test runners without an RTK filter, get RTK's `term` chain.
- Pi's `grep`, `find`, and `ls`, plus FFF's `ffgrep`, `fffind`, and multi-grep, are windowed past 300 lines without losing FFF file headings or cursors; Pi `grep` lines are grouped by file.
- MCP and other extension tools lose terminal escapes, base64 runs, and repeated lines, and get lossless JSON compaction, shared-tail footnotes, and passage deduplication.

Code and prose stay byte-exact, so edits can rely on the text a read returned.
Every stub and condensed view is labelled, and reading the same path and offset again returns the exact text.
Install RTK separately and keep its Pi hook enabled; commands it rewrites are left to it.
`ffgrep` results need an FFF integration such as `@ff-labs/pi-fff`; Pi's built-in `grep` is a different tool.

This extension replaces the former `rtk-ffgrep` extension.
Remove any separately installed copy of `rtk-ffgrep`; if both load, the second filter usually finds nothing left to change.

RTK output is accepted only if it keeps the final line and Pi's full-output notices, and RTK's recall returns the exact original; otherwise the original result stays.
Every replacement must save at least 128 bytes and 10%, and RTK is not started when none of its methods could change the output.

```text
/rtk-coverage [days 1-365] [project|all]
```

Reports, from Pi's own session files, how much tool output each tool delivered and which integration owns it.
It splits Bash output by whether RTK's current rewrite rules cover the command, and shows the extension's filtered, unchanged, and failed results with real byte counts.
These numbers are Pi-specific; `rtk gain` mixes every agent and counts rejected submissions.
See [RTK for other Pi tools](rtk-pi-extended/README.md) for the coverage table, safety checks, and tests.

## RTK gain

Pi's footer shows the estimated tokens RTK saved in the current environment, for example `RTK: 12.4K tokens saved (37.5%)`.
It reads `rtk gain --format json` on session start, after tool-using turns and agent completion, and when either command below runs.
There is no polling, model call, or separate history file.
If RTK is missing or its counters cannot be read, the footer entry disappears; `/rtk-gain` reports the failure.
Custom footers must display Pi's extension statuses to show the entry.

- `/rtk-gain` shows the exact reported token counts before and after filtering, tokens saved, savings percentage, and command count for this host or sandbox.
- `/rtk-gain all`, run on the host, adds one row per local Docker sandbox from `sbx ls --json` and a combined total for the environments that reported counters.
  The combined percentage is total saved divided by total before, not an average of percentages.
  Only guests listed as running are queried; stopped or unreadable guests are marked as excluded, not counted as zero.
  If a guest stops between listing and querying, `sbx exec` can restart it.

These are RTK estimates across all agents using each RTK history, not billed tokens or Pi session usage.
Use `/rtk-coverage` for the bytes actually removed by `rtk-pi-extended` in Pi sessions.
The two extensions can be enabled independently.
Deleting a sandbox removes its RTK history from the combined report.

## Trace

Use `/trace` to browse recorded tool results, `/trace failed` to list errors, or `/trace failed bash` to filter by exact tool name.
Results are newest first on the active branch, including retained entries from before compaction.
The picker shows status, tool, time, and session entry ID, not commands or output.
Select a row for its retained text, or use the older/newer choices to page through history.
The preview strips terminal controls, redacts common credential patterns, and is limited to the last 20 lines and 4,000 UTF-16 code units.
If the 16,384-unit input tail starts mid-line, that line is omitted because it can lack the label identifying a credential.
Diagnostics can still contain private data.

Errors are Pi's `isError` flag, not guesses from text or exit-code strings.
Direct `!` shell commands, nested calls without their own result entry, images, tool details, and files mentioned in output are not inspected.
Trace never reruns a tool, calls a model, or adds a session entry.

## Worker board

Use `/workers` to pin a board above the editor, `/workers 2` to see another page, and `/workers hide` to close it.
The source is the **parent session's `subagent` tool**, such as Pi 1.6's optional `examples/extensions/subagent` runner.
The board does not install or start the runner; without reports it stays empty rather than showing unrelated sessions.
To use Pi's example, load it with `-e "$PI_PACKAGE_ROOT/examples/extensions/subagent/index.ts"` and define a user agent in `~/.pi/agent/agents/` as described in the runner's README.
Open `/workers` in the parent session before delegating a task.
Delegation can incur model charges; viewing the board does not.

The board follows top-level calls in the current batch and restores the latest batch on the active branch after it finishes.
Each row shows the reported state, worker, source reference and slot, original assignment preview, and last reported tool name when available.
The reference is the tool call ID during execution and the session result entry ID after recording.
Failed and explicitly blocked workers sort first, with six workers per page and at most two terminal lines per row.
A completed worker means the **runner** reported completion, not that tests passed.
Silence is not a blocker, and a saved `running` report is not evidence of a live process.

Compatible runners use tool name `subagent` and emit `details.mode` (`single`, `parallel`, or `chain`) and ordered `details.results` with `agent` and `status` fields.
Pi's example reports `pending`, `running`, `completed`, `failed`, or `aborted`; the board also accepts an explicit `blocked` with optional `blocker` text.
Workers with the same name keep separate slots.
Chain assignments use the original prompt template, never the previous worker's expanded output.
The board does not read transcript files, send messages, infer missing outcomes, or make model calls.
Assignment previews can contain private text; common credential redaction is not a guarantee.

Both commands work in the terminal and with RPC clients that implement Pi's extension UI.
To try the two extensions from this checkout without installing them:

```sh
pi -e ./trace/index.ts -e ./worker-board/index.ts
```

Run `node --test trace/tests/*.test.mjs worker-board/tests/*.test.mjs` from the package root.
If the Pi peers are not installed in the checkout, set `PI_PACKAGE_ROOT` to the installed `@earendil-works/pi-coding-agent` directory for the worker-board tests.

## Update or remove

Use Pi to update installed packages:

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
