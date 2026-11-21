# Pi Extensions

Nine independent extensions for [Pi](https://pi.dev) covering interactive Git workflows, quick WIP commits, PhpStorm MCP registration for `pi-acp`, portable cross-harness task progress, RTK post-tool output filtering and token-savings reporting, recorded tool-result inspection, and live subagent status boards.

Enable only the extensions you need.

## Extensions at a glance

| Extension | Entry point | Surface | Modes | Model calls | What it does |
| --- | --- | --- | --- | --- | --- |
| [Exit](#exit) | `exit.ts` | `/exit` | Any with commands | No | Requests an orderly Pi shutdown via `ctx.shutdown()` so shutdown hooks finish cleanly. |
| [Git](#git) | `git/index.ts` | `/git`, `git-output` entry renderer | `tui` | No | Runs Git commands and aliases in a real pseudoterminal with inline sanitized output tails. |
| [WIP](#wip) | `wip.ts` | `/wip` | Any with commands | No | Runs `git add .` then `git commit -m "wip"` in the current working directory without exposing hook output. |
| [PhpStorm MCP integration for pi acp](#phpstorm-mcp-integration-for-pi-acp) | `phpstorm-mcp/index.ts` | `session_start` MCP registration (`phpstorm`) | `rpc` only | No | Registers PhpStorm's MCP server for ACP/RPC sessions only while the PhpStorm GUI is running locally. |
| [Progress](#progress) | `progress/index.ts` | `/progress`, `progress` tool, `progress/cli.ts`, background updater | All | Yes (opt-in) | Tracks tasks, decisions, steps, and blockers in `~/.config/ai-sessions/<folder>/progress.json` with background updates after replies. |
| [RTK for other Pi tools](#rtk-for-other-pi-tools) | `rtk-pi-extended/index.ts` | `tool_result` filter, `/rtk-coverage` | All | No | Deduplicates `read` calls, condenses non-code files, filters non-rewritten Bash/search/MCP output through RTK, and reports Pi session savings. |
| [RTK gain](#rtk-gain) | `rtk-gain/index.ts` | Status-bar item, `/rtk-gain [all]` | All (footer requires UI) | No | Displays local RTK token savings in the footer and summarizes host + running Docker sandbox totals. |
| [Trace](#trace) | `trace/index.ts` | `/trace [failed] [tool]` | `tui`, `rpc` (with UI) | No | Browses recorded tool results, sanitized call previews, nested `codemode` calls, and failures on the active branch with bounded, redacted output tails. |
| [Worker board](#worker-board) | `worker-board/index.ts` | `/workers [page\|hide]`, auto-opened widget | `tui`, `rpc` (with UI) | No | Auto-opens on live worker/workflow runs (unless hidden) to show assignments, blockers, and outcomes from Pi's example `subagent` runner or `pi-subagents`. |

## Installation

Pi's Git-package installer installs from the repository root, where `package.json` declares all nine entry points under `pi.extensions`.
Requires **Node.js 22.19 or newer** and **Git**.

```sh
pi install git:github.com/zaherg/pi-extensions
pi config
```

- The package is registered globally in `~/.pi/agent/settings.json` with all extensions enabled initially; use `pi config` to disable any extensions you do not want loaded.
- No build step or manual `npm install` is required—Pi supplies the peer dependencies (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`).
- Remove or disable earlier standalone copies of these extensions (including the retired `rtk-ffgrep` extension) before reloading so commands, hooks, and tools are not registered twice.
- Run `/reload` or restart Pi after changing enabled extensions. Restart existing ACP/RPC sessions after installing or editing PhpStorm MCP settings.

To test individual extensions directly from a local checkout without installing the package globally:

```sh
pi -e ./trace/index.ts -e ./worker-board/index.ts
```

To typecheck and lint a local checkout without installing `node_modules` (running `tsc --noEmit` against local `./node_modules` when present or the installed Pi release in `~/.pi/agent/install`, followed by `biome lint`):

```sh
npm run check
```

### Important notes

- **No subdirectory install URLs:** `git:github.com/zaherg/pi-extensions/<extension-name>` does not install a single extension. Pi passes the full URL to Git as a repository address rather than selecting a subdirectory inside this repo.
- **External prerequisites are separate:** Installing this package does not install [RTK](https://github.com/rtk-ai/rtk), `sbx`, FFF (`@ff-labs/pi-fff`), `pi-acp`, PhpStorm's MCP server, or a `subagent` runner, and it does not enable `progress` tracking in any directory.
- **Permissions:** Extensions execute in-process with the same OS permissions as Pi. Review the source before installing.

---

## Exit

**Entry point:** `exit.ts`

```text
/exit
```

Requests a normal, graceful Pi shutdown by calling `ctx.shutdown()` instead of terminating the Node process abruptly.

### What it does

- Triggers `session_shutdown` across all loaded extensions before Pi exits:
  - [Progress](#progress) finishes an in-flight or latest queued background update (up to its 60-second model deadline) and completes its atomic file write.
  - [RTK for other Pi tools](#rtk-for-other-pi-tools) aborts active child filters and awaits cleanup.
  - [RTK gain](#rtk-gain), [Trace](#trace), and [Worker board](#worker-board) abort pending UI/command work and clear transient UI state.
- Ignores any trailing arguments passed after `/exit`.
- Uses no configuration files, writes no session entries, and makes no model calls.

---

## Git

**Entry points:** `git/index.ts`, `git/terminal.ts` (detailed reference: [git/README.md](git/README.md))

```text
/git
/git status
/git add -p
/git diff --cached
/git commit "Fix validation"
/git log --oneline -10
```

Runs any Git command or alias in Pi's current working directory (`ctx.cwd`) inside a real pseudoterminal, suspending Pi's TUI during execution and appending a bounded, sanitized output summary inline when finished.

### Command syntax and commit shorthand

- **Bare `/git`:** Runs `git` and shows Git's help/usage output.
- **Commit shorthand:** Only a standalone single- or double-quoted message—`/git commit "message"` or `/git commit 'message'`—is rewritten to `git commit -m ...`. It commits **only what is already staged** in the index and never stages files automatically.
- **Native passthrough:** Every other invocation runs as `git <args>`, including `/git commit -m "Fix" --amend`, `/git commit -am "Fix"`, pathspecs, Git aliases, pipes, redirects, shell expansions, and chained shell commands.
- Because `<args>` is evaluated by your shell (`$SHELL`, falling back to `/bin/sh`), run only trusted input; destructive Git commands and repository hooks execute without extra confirmation.

### Terminal execution and signal handling

- **Interactive TUI only:** Requires `ctx.mode === "tui"` and `ctx.isIdle() === true`. Non-interactive modes throw an error; running `/git` while another command or agent turn is active shows a warning.
- **Full PTY handoff:** Stops Pi's TUI and launches `/bin/bash` with `/usr/bin/script`, `/usr/bin/tee /dev/tty`, and `/usr/bin/tail -c 16384` (supported on **macOS** and **Linux**). Interactive editors, pagers, GPG/SSH prompts, credential helpers, and `git add -p` attach to a real terminal and return automatically when Git exits without an extra "Press Enter" prompt.
- **Ctrl+C safety:** Parent `SIGINT` is ignored while the foreground terminal is handed off (and drained across two `setImmediate` turns after `spawnSync` returns), and macOS `script` signal exit codes are normalized to `130`. Pressing `Ctrl+C` interrupts the foreground Git command without killing Pi, though changes Git already wrote remain on disk.

### Inline transcript output and privacy

- Captures at most the final **16 KiB** (`16,384` bytes) of combined stdout/stderr, strips ANSI/VT sequences and control characters, redacts common credential patterns via `shared/display.ts`, and formats at most the last **20 lines** and **4,000 UTF-16 code units** (prefixed with `[Last output only]` when truncated).
- Saves the sanitized summary as a custom `git-output` session entry rendered in the transcript. `git-output` entries are **display-only**—they are never sent to the model, and `/git` makes no model calls.
- Full unfiltered command text and live output can still remain in your terminal emulator's scrollback buffer and Pi's input history.

---

## WIP

**Entry point:** `wip.ts`

```text
/wip
```

Stages changes under Pi's current working directory and creates a `wip` commit in two sequential non-shell `pi.exec` steps, with no model call:

```sh
git add .
git commit -m "wip"
```

### Behavior and edge cases

- **No arguments:** Passing any argument (for example `/wip message`) is rejected with `Usage: /wip (no arguments)` before touching Git. Concurrent `/wip` invocations are also blocked.
- **Automatic staging scope:** Unlike `/git commit "..."`, `/wip` stages modified, deleted, and untracked files under `ctx.cwd` (honoring `.gitignore` and Git's ignore rules). Running `/wip` from a subdirectory stages under that subdirectory, while **also** committing any changes that were already staged elsewhere in the repository index.
- **No push:** Never pushes to a remote.
- **Failure and hook privacy:**
  - If `git add .` fails or is killed, `git commit` is not attempted.
  - If `git commit -m "wip"` fails (for example, nothing to commit or a pre-commit hook failure), staged changes remain in the index—check `git status` before retrying.
  - Because Git hooks can print secrets or environment variables, `/wip` reports only which command failed or was interrupted and its numeric exit code; raw Git/hook stdout and stderr are never echoed into Pi.

---

## PhpStorm MCP integration for pi acp

**Entry points:** `phpstorm-mcp/index.ts`, `phpstorm-mcp/running.ts` (detailed reference: [phpstorm-mcp/README.md](phpstorm-mcp/README.md))

Connects `pi-acp` sessions running inside JetBrains IDEs to PhpStorm's built-in MCP server while keeping normal terminal (`tui`), `print`, and `json` Pi sessions completely separate from the IDE.

### How it works

At `session_start`, the extension:
1. Checks `ctx.mode === "rpc"`. Non-RPC sessions (`tui`, `print`, `json`) return immediately without running OS process checks, reading configuration, or registering any server.
2. Checks whether the **PhpStorm GUI** is currently running on the host (`isPhpStormRunning`), explicitly ignoring leftover `stdioMcpServer` bridge processes:
   - **macOS (`darwin`):** Queries `NSRunningApplication` via `/usr/bin/osascript` (JXA) for bundle identifier `com.jetbrains.PhpStorm` with non-terminated regular GUI activation policy (`0`).
   - **Linux (`linux`):** Runs `ps -Aww -o comm= -o args=` and matches `phpstorm`, `phpstorm64`, or `java` with `-Didea.platform.prefix=PhpStorm`, excluding `stdioMcpServer` arguments.
   - **Windows (`win32`):** Queries `Win32_Process` via `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (absolute, never resolved from the working directory) for `phpstorm64.exe` or `phpstorm.exe`, excluding `stdioMcpServer` command lines.
   - Process checks have a **2-second timeout** and **1 MiB output limit**, and sanitize child-process errors so process arguments are never leaked.
3. If PhpStorm is not running, exits silently without registering MCP. If the process query itself fails, throws a descriptive error without registering.
4. Reads `~/.pi/agent/pi-phpstorm-mcp.json` (creating it automatically with default values if missing) and calls `pi.registerMcpServer("phpstorm", config)` for the current session.

### Setup and configuration

1. Enable PhpStorm's built-in MCP server in PhpStorm settings and copy its command, arguments, and port.
2. Keep Pi's built-in MCP support enabled and configure `pi-acp` in PhpStorm (this extension does not install `pi-acp`).
3. Create `~/.pi/agent/pi-phpstorm-mcp.json` as a **single server object** (no outer `mcpServers` wrapper):

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

4. Restart the ACP/RPC session.

### Caveats

- **Auto-created defaults (`~/.pi/agent/pi-phpstorm-mcp.json`):** If the file is missing (`ENOENT`), it is created (`0600`) with `~/Applications/PhpStorm.app/Contents/MacOS/phpstorm` (derived from `os.homedir()`) and port `64442`. Edit it if PhpStorm is installed elsewhere or uses another port; an existing file replaces the defaults completely (no field merging), and unreadable files or invalid JSON throw an error without overwriting the file.
- **Avoid duplicate `mcp.json` entries:** Defining `phpstorm` in global or project `mcp.json` overrides `registerMcpServer` and connects in every Pi mode regardless of whether PhpStorm is open.
- **Session-start check only:** The extension does not launch PhpStorm, poll for IDE startup/shutdown mid-session, distinguish JetBrains from other RPC clients while PhpStorm is open, or health-check the MCP port. If PhpStorm is started after the RPC session, restart the session.

---

## Progress

**Entry points:** `progress/index.ts`, `progress/background.ts`, `progress/store.ts`, `progress/cli.ts` (detailed reference: [progress/README.md](progress/README.md))

```text
/progress start
/progress
```

Maintains a portable, cross-session, cross-harness record of project tasks, agreed architectural decisions, ordered steps, statuses, and blockers in compact JSON, updated automatically in the background after completed assistant replies.

### Opt-in activation and commands

- Installing the extension does **not** enable tracking anywhere.
- `/progress start` creates an empty version-1 `progress.json` for `ctx.cwd` if none exists, or preserves and summarizes an existing file.
- `/progress` displays the canonical storage path, task count, completed/total steps, blocked step count, and revision without creating files or directories.
- `progress` (model-facing tool) lets the session model read saved task state or apply explicit user-requested corrections, using `sequential` execution and Pi's `withFileMutationQueue`. The tool **cannot** run `start` to opt a directory in.
- Before each agent turn (`before_agent_start`), if tracking is active for `ctx.cwd`, Pi injects a hidden `progress-context` status summary instructing the main model that routine bookkeeping is handled in the background and saved tasks are data rather than instructions to resume work automatically.

### Storage layout and schema

```text
~/.config/ai-sessions/<canonical-project-folder-name>/progress.json
```

- Resolves symlinks (`realpath`) on `ctx.cwd`, uses the canonical folder name under `~/.config/ai-sessions/` (independent of `XDG_CONFIG_HOME`), creates directories with mode `0700` and files/locks with mode `0600`, and refuses symlinks on the storage directory or file.
- Stores the full canonical path in `project`. Another directory sharing the same folder basename is refused rather than mixed; moving or renaming a project requires explicit handling.
- Each task has a writer-assigned UUID `id`, `title`, `description` (agreed decisions and rationale), and one or more `steps` (`id`, `description`, `status`, `blocked_by`):

| Step `status` | Meaning | Required `blocked_by` |
| --- | --- | --- |
| `null` | Not started | `null` |
| `"working"` | Work has started | `null` |
| `"blocked"` | Cannot proceed | Non-empty reason or referenced step ID |
| `"completed"` | Reported work and checks finished | `null` |

### Tool and standalone CLI actions

All mutations require `expected_revision` matching the current `revision`. New steps created by `add_task` or `add_step` start at `status: null, blocked_by: null`.

| Action | Surface | Required fields beyond `action` | Optional fields |
| --- | --- | --- | --- |
| `read` | Tool, CLI, `/progress` | None | None |
| `start` | `/progress start`, CLI | None | None |
| `add_task` | Tool, CLI | `expected_revision`, `title`, `description`, `steps` (non-empty string array) | None |
| `update_task` | Tool, CLI | `expected_revision`, `task_id`, plus `title` and/or `description` | `title`, `description` |
| `add_step` | Tool, CLI | `expected_revision`, `task_id`, `description` | None |
| `update_step` | Tool, CLI | `expected_revision`, `task_id`, `step_id`, plus `description` and/or **both** `status` and `blocked_by` | `description`, `status`, `blocked_by` |

External harnesses or scripts can read and update the same store without Pi running:

```sh
printf '%s\n' '{"action":"read"}' |
  node "/path/to/pi-extensions/progress/cli.ts" --cwd /path/to/project
```

### Background updater, model settings, and privacy

- **Scheduling & lifecycle:** Triggered at `agent_settled` after non-aborted, completed assistant replies without blocking the next prompt. Runs one update at a time, coalesces queued settlements to the latest snapshot, cancels active work on `input`, `before_agent_start`, `session_tree`, reload, or session switch, and drains active/queued updates on graceful quit (`event.reason === "quit"`).
- **Patch rules:** The background model has no tools or filesystem access and returns a single-line minified JSON patch. Omitted tasks and steps are preserved; tasks and steps cannot be deleted, reordered, or given invented IDs. Completion reflects conversation evidence, not independent verification.
- **Model selection:** Uses Pi's effective `defaultProvider` and `defaultModel` (not the active session model) unless overridden in `~/.pi/agent/settings.json` (or trusted `.pi/settings.json`) followed by `/reload`:

```json
{
  "progress": {
    "model": "your-provider/your-model-id"
  }
}
```

- **Limits, billing, & privacy:** **Enabling tracking makes additional, billable model calls** (`60`-second deadline, `4,096` max output tokens, no retries or fallback models). Usage is logged in non-context `progress-usage` custom entries and is **not** included in Pi's `/session` totals. Only saved task records plus a bounded slice of recent user messages and completed assistant text (`<= 24` messages, `<= 6,000` chars/message, `<= 16,000` chars total, `<= 64,000`-byte request payload) are sent—excluding hidden thinking, raw tool calls/results, images, system prompts, and compaction summaries. Heuristic secret redaction is applied before sending and before saving, but is not a guarantee against leaking sensitive text.
- **Locking & disabling:** Mutations lock `progress.lock` (`O_EXCL`, up to `2`s wait before `LOCKED`; locks are never stolen automatically), verify `expected_revision` (`CONFLICT` on mismatch), write and `fsync` a temp file, atomically rename over `progress.json`, and sync the directory (`DURABILITY_UNCERTAIN` if dir sync fails). There is no `/progress stop`; to pause tracking while keeping history, stop all writers and move `progress.json` to a backup path.

---

## RTK for other Pi tools

**Entry point:** `rtk-pi-extended/index.ts` (detailed reference: [rtk-pi-extended/README.md](rtk-pi-extended/README.md))

Reduces tool outputs in `tool_result` that RTK's stock pre-execution Bash hook (`extensions/rtk.ts`) never sees, while keeping source code and prose byte-exact for `edit`. Also adds `/rtk-coverage` for Pi-specific coverage and byte-savings analytics. Replaces the former `rtk-ffgrep` extension.

### Tool routing

| Tool results | Route | What happens |
| --- | --- | --- |
| `read` | `read` | Identical repeat reads become stubs; overlapping ranges collapse shared lines to a marker; lockfiles, minified assets, large truncated JSON, and logs get labelled views; all code and prose stay byte-exact. |
| Successful single-file `bash` readers (`cat`, `sed -n`, `head`, `tail`, `nl`, `rtk read`) | `read` | Same labelled non-code views as `read`; code and prose stay byte-exact. |
| Other `bash` commands (including non-zero exits) | `terminal` | Filtered through RTK's `term` pipeline (`ansi`, progress stripping, adjacent line dedup, base64 elision, `300`-line head/tail windowing, `2,000`-char line cap). |
| `bash` commands already rewritten to `rtk ...` | `terminal` | Filtered only when output still contains ANSI escapes or `\r` (meaning RTK passed output through unfiltered); otherwise left untouched to avoid double filtering. |
| `grep`, `find`, `ls`, FFF's `ffgrep`, `fffind`, `fff-multi-grep`, and override names | `listing` | RTK `ansi` + `cap` windowing past `300` lines while preserving FFF file headings and pagination cursors, plus lossless per-file heading grouping for Pi `grep`. |
| MCP and other extension tools | `generic` | RTK `ansi`, `base64-elide`, and `dedup` (without line-count truncation), followed by lossless JSON compaction, shared-tail footnotes (`>= 40` chars on `>= 3` lines), and repeated-passage pointers (`>= 256` bytes, keeping the final passage). |
| `edit`, `write`, `rtk recall`, `< 512` bytes, multi-block/image results, nested tool calls, non-`bash` errors | none | Always passed through untouched. |

### Read safety, non-code views, and exact recovery

- **Projection-aware `read` deduplication:** Compares actual returned text against earlier `read` results still present in `ctx.sessionManager.buildSessionProjection()`. Compaction, branch switches (`session_tree`), successful `edit`/`write` calls on that path, or external file edits automatically prevent stale stubs.
- **Labelled non-code file classes:** Only four classes are ever condensed, each prefixed with an `[rtk-pi-extended]` notice warning not to copy the view into `edit`:
  - **Lockfiles** (`bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `go.sum`): unique `name@version` summary when `>= 3` packages are detected.
  - **Minified / sourcemaps** (`*.min.js`, `*.min.mjs`, `*.min.cjs`, `*.min.css`, `*.js.map`, `*.css.map`): lines over `300` chars trimmed with `…[+N chars]`.
  - **Large JSON** (`*.json` `>= 16 KB`): leading indentation stripped (for `read`, only when Pi already truncated the file).
  - **Logs** (`*.log`, `*.log.N`): RTK `term` chain with recall hint.
- **Exact text on demand:** Re-reading the same path and offset immediately after a stub or condensed view (or reading any range after a condensed Bash file view) bypasses condensation and returns the exact literal file text.

### Verification gates, environment controls, and RTK config

- **Minimum savings & pre-spawn gate:** Every replacement must save at least **128 bytes AND 10%**. Before spawning `rtk`, `gate.ts` checks whether any method in `rtk/{terminal,listing,generic}/pipeline.toml` could alter the input; if not, `rtk` is not started.
- **Structure & recall verification:** RTK replacements (`2`-second timeout, `2 MiB` input/output cap, stdin-only transport) are accepted only if the final line, every Pi `[... Full output: path]` notice, and (for `listing`) every FFF heading survive, **and** RTK emits a native recall hint verified once per session via `rtk recall --full` (requires RTK's default `sqlite` recall store). Any failure retains the original output and warns once per failure category without leaking tool text. Only `content[0].text` changes; `details`, usage, `isError`, and `structuredContent` remain intact.
- **Bypass:** Set `RTK_DISABLED=1` in Pi's environment to bypass the extension completely.
- **Optional RTK `config.toml` tuning:** Adding `exclude_commands = ["cat", "bun run", "bun test", "bunx"]` under `[hooks]` in RTK's `config.toml` avoids extra `rtk read` / `bun` wrapper processes so `rtk-pi-extended` can filter escape-free `bun` output directly.

### Coverage report

```text
/rtk-coverage [days 1-365] [project|all]
```

Scans Pi session files (default: last `30` days in `project`, including nested subagent sessions) and reports total/per-tool byte volume, savings by mechanism (from non-context `rtk-pi-extended` turn-end ledger entries), Bash coverage classified via `rtk rewrite` (up to `2,000` largest distinct commands, never executing them), and filtered/unchanged/failed counts.

---

## RTK gain

**Entry point:** `rtk-gain/index.ts`

```text
/rtk-gain
/rtk-gain all
```

Displays local RTK token-savings totals in Pi's footer (for example `RTK: 12.4K tokens saved (37.5%)`) and provides detailed local and multi-sandbox summaries on demand.

### Footer status lifecycle

- Runs `rtk gain --format json` (`5`-second timeout, `1 MiB` buffer cap, safe-integer validation) at `session_start`, at `turn_end` whenever at least one tool ran (`event.toolResults.length > 0`), at `agent_settled`, and whenever `/rtk-gain` is invoked.
- Overlapping background refreshes coalesce into at most one queued follow-up read—there is no timer polling, no separate state file, and no model call.
- If `rtk` is not installed or returns an unreadable report, the `rtk-gain` status item clears silently; `session_shutdown` aborts any in-flight command and clears the status item. Custom footers must render Pi's extension status entries to show it.

### Commands and Docker sandbox aggregation

- **`/rtk-gain`:** Waits for any in-flight background read to finish, runs a fresh `rtk gain --format json`, updates the footer, and displays exact `total_saved`, percentage, `total_commands`, `total_input` (tokens before), and `total_output` (tokens after).
- **`/rtk-gain all`:** Queries local host counters first, lists Docker sandboxes via `sbx --no-input ls --json`, and queries every sandbox reported as `"running"` in parallel via `sbx --no-input exec -- <name> rtk gain --format json`:
  - Prepends `Total` (or `Total (reported only)` as a warning when some environments were excluded) with a weighted percentage (`total_saved / total_input`, never an unweighted average of percentages).
  - Stopped, non-running, missing-`rtk`, or timed-out sandboxes are listed as `excluded (<reason>)` rather than counted as zero. (Note: if a sandbox stops in the narrow window between `sbx ls` and `sbx exec`, `sbx exec` can start it.)
  - Deleting a sandbox deletes its internal RTK history from future `/rtk-gain all` totals.
- **Scope difference:** `rtk gain` reports RTK's estimated token counts across **every** agent and hook submission sharing that RTK database, not billed provider tokens or Pi-only sessions. Use `/rtk-coverage` from [RTK for other Pi tools](#rtk-for-other-pi-tools) for exact Pi session byte reductions; the two extensions work independently.

---

## Trace

**Entry point:** `trace/index.ts` (uses `shared/display.ts`)

```text
/trace
/trace bash
/trace failed
/trace failed bash
```

Interactive browser for recorded `toolResult` messages on the active session branch—letting you inspect past tool outputs, sanitized call previews, and nested `codemode` calls without re-executing commands, spending tokens, or mutating the session.

### Filtering and picker navigation

- **Commands:**
  - `/trace` — lists all recorded `toolResult` entries on `ctx.sessionManager.getBranch()`, newest first (including entries recorded before compaction that remain on the branch).
  - `/trace <tool>` — filters entries by exact `toolName` match (such as `bash`, `read`, `edit`, `codemode`, or an MCP tool name), and also includes `codemode` entries whose `details.calls` invoked `<tool>`.
  - `/trace failed` — lists entries where Pi recorded `msg.isError === true` or where a `codemode` entry recorded nested calls with `status` of `"error"` or `"cancelled"` (never guessing failure from output words or exit-code text).
  - `/trace failed <tool>` — filters failed entries by exact `toolName` match, or `codemode` entries with a failed nested call to `<tool>`. Any other argument combination shows usage help.
- **Paginated, persistent selector:** Displays **25 results per page** with `Older results →` and `← Newer results` navigation items. Each row shows `<index>. ok|failed|nested-err <tool> (<preview>) · <timestamp> · #<entryId>`, pairing `toolCallId` with sanitized `toolCall` previews (`command`, `path`, `file_path`, `pattern`, `query`, `url`, `action`, `agent`, `workflow`, or the first non-`// @options:` line of `code` via `displayLabel`, plus compact nested counts/tool hints like `[1/2 err]` or `[bash]` on `codemode` rows). Selecting an item shows diagnostics (`warning` for failed or `nested-err` entries, `info` otherwise) and keeps the picker open on the current page until you press `Esc` / cancel.
- **Branch safety:** Switching branches (`session_tree`) or shutting down (`session_shutdown`) aborts an open `/trace` selector immediately, and selecting an entry re-verifies that the entry ID is still on the active branch before showing diagnostics.
- Works in both interactive terminal (`tui`) mode and `rpc` clients that implement `ctx.ui.select` and `ctx.ui.notify`.

### Bounded diagnostics, redaction, and exclusions

- **Nested `codemode` call summary:** When inspecting a `codemode` result with `details.calls`, Trace prepends a sanitized `[Nested calls]` summary (capped to the last **10** nested calls, showing status, tool name, truncated arguments, and truncated error text) ahead of the output tail so caught inner failures are visible immediately.
- **Backward tail assembly:** Walks `content` text blocks from the end to collect at most **16,384 UTF-16 code units**. If the cut starts mid-block/mid-line, `displayTail` drops that partial leading line because its missing prefix could hide a credential label (such as `API_KEY=`).
- **Sanitization (`shared/display.ts`):** Strips ANSI/VT escape sequences and Unicode control/format characters (preserving `\n` and `\t`), redacts common credential formats (PEM private keys, `Bearer`/`Basic` headers, `password`/`passwd`/`secret`/`token`/`api_key`/`access_key` assignments, signed URL query parameters, `sk-*` / `gh*_*` / `github_pat_*` / `AKIA*` tokens, and URL `user:pass@` userinfo), preserves UTF-16 surrogate pairs cleanly, and outputs at most the last **20 lines** and **4,000 UTF-16 code units** (marked with `[Last output only]` when truncated). Redaction is heuristic—diagnostics can still contain sensitive project data.
- **What Trace never inspects:** User `!` interactive shell executions (`bashExecution` messages), image blocks, external full-output files referenced in truncation notices, `details` payloads other than `codemode`'s `details.calls` summary, and other nested sub-tool calls without their own parent-branch `toolResult` entry or `codemode` call record.

---

## Worker board

**Entry points:** `worker-board/index.ts`, `worker-board/report.ts` (uses `shared/display.ts`)

```text
/workers
/workers 2
/workers hide
```

Pins a compact, paginated status board above the editor showing delegated worker assignments, blockers, last used tools, and reported outcomes from the **parent session's `subagent` tool** (supporting both Pi 1.6's `examples/extensions/subagent/index.ts` and `pi-subagents`).

### Setup and runner contract

- Worker board is a passive UI observer—it does **not** bundle, install, or invoke a `subagent` runner, read external subagent transcript files, send agent messages, or make model calls. Without `subagent` calls on the active branch, opening `/workers` displays `No subagent calls on this branch.`
- Delegated worker and workflow runs **auto-open** the board on page 1 at `tool_execution_start` unless hidden with `/workers hide` (which suppresses auto-open for the rest of the current batch and resets when the turn settles; standalone `management` actions do not auto-open a closed board). Use `/workers [page|hide]` anytime to reopen, paginate, or close the widget manually.
- To try it with Pi's built-in example runner, load the runner alongside `worker-board` and define at least one agent under `~/.pi/agent/agents/` (see the runner's own README):

```sh
pi -e "$PI_PACKAGE_ROOT/examples/extensions/subagent/index.ts" -e ./worker-board/index.ts
```

- **Compatible `subagent` payloads:** Top-level tool named `subagent` (`parentToolCallId === undefined`) emitting `details.mode` (`"single"`, `"parallel"`, `"chain"`, `"workflow"`, or `"management"`) and `details.results`:
  - **Worker entries (`details.results`):** Reads `agent` and `status` (`"pending"`, `"running"`, `"completed"`, `"failed"`, `"aborted"`, or `"blocked"` with optional `"blocker"`), or infers status for `pi-subagents` from numeric `exitCode` (`0` → `"completed"`, non-zero → `"failed"`) or `"running"` while live. Scans `messages` backward first and falls back to `toolCalls` (`{ text }`) for `last: <tool>`. Malformed worker slots render as `#<ref>/<slot> Unsupported worker report.`
  - **Empty-`results` launches & actions (`pi-subagents`):** Renders `workflow` runs (using `workflowChildren.workflowState`, `args.workflow`, `args.mission`, and optional `async` tag), `asyncId` worker launches (`running (async)` while live, `last reported async` once settled), and `management` actions (`management:<action>` with optional `lifecycleStatus` / `steering` state). Other empty `results: []` calls (such as a declined confirmation prompt) report `No worker outcome reported.`

### Live batch tracking vs. persisted history

- **Live execution (`Workers · current batch`):** Subscribes to `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` for top-level `subagent` calls in the current turn, updating rows in place as partial results stream in. Each worker is addressed as `#<toolCallId>/<slot>`, keeping concurrent `subagent` calls and duplicate agent names distinct.
- **Settled branch state (`Workers · last recorded batch`):** At `turn_start`, `agent_end`, and `session_tree`, clears transient live state, resets the batch `hidden` flag, and reconstructs the most recent assistant message containing `subagent` tool calls on `ctx.sessionManager.getBranch()` (matching the newest `toolResult` per `toolCallId` and referencing `#<entryId>/<slot>`). `session_shutdown` clears state and hides the widget.
- **Honest historical state:** Any persisted non-live result still carrying `"running"`, `"pending"`, or an `asyncId` launch is rendered as `last reported running`, `last reported pending`, or `last reported async` so a saved snapshot is never mistaken for a verified live OS process. Likewise, `completed` means the runner reported completion, not that tests or builds succeeded, and worker silence is never synthesized into `blocked`.

### Sorting, pagination, layout, and privacy

- **Priority order:** Rows sort by severity so failures and blockers never scroll below finished work:
  1. `blocked` and `failed` (including top-level call failures)
  2. `aborted` (and malformed/missing report notices)
  3. `running` (including async and running workflow rows)
  4. `pending`
  5. `completed` (including completed workflow and management rows)
- **Row format & two-line cap:** `<status> <agent> #<ref>/<slot> · blocked by: <blocker> · <task> · last: <tool>`. Pages show **6 workers per page** (`/workers <N>` jumps to page `N`; `/workers hide` closes the board). In `tui` mode, each line wraps and truncates to **at most two terminal lines** using width-aware ANSI wrapping; in `rpc` mode, the string array is passed to `ctx.ui.setWidget("worker-board", lines)`.
- **Chain prompt safety & redaction:** In `"chain"` mode, `result.task` can contain a previous worker's entire expanded output, so Worker board reads assignment previews exclusively from the original `args.chain[i]` prompt template (only when `request.agent === raw.agent`) and sanitizes all labels through `shared/display.ts`. Assignment previews can still contain sensitive prompt text.

---

## Update or remove

Update installed extension packages:

```sh
pi update --extensions
```

Use `pi config` to disable individual extensions, or uninstall the package completely:

```sh
pi remove git:github.com/zaherg/pi-extensions
```

Run `/reload` or restart Pi afterward.
Removing the package does not delete saved `progress.json` files under `~/.config/ai-sessions/`, `~/.pi/agent/pi-phpstorm-mcp.json`, or RTK's history database.

## License

[MIT](LICENSE.md).
