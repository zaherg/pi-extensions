# Portable task progress

This local Pi extension maintains task descriptions, agreed decisions, steps, and step status in a JSON file that other models and harnesses can read.
Tracking is opt-in per directory and persists across Pi sessions.
A background model supplies progress updates after finished replies; the extension validates and saves them but cannot prove that a step is complete.

## Start tracking in Pi

Run `/reload` after installing the extension, then run these commands from the project directory:

```text
/progress start
/progress
```

`/progress start` creates the file only if it does not exist.
Repeating it preserves existing progress.
`/progress` shows the location and counts without creating anything.
The model-facing `progress` tool cannot enable tracking.
After activation, a background updater maintains the file without making the main model perform routine progress bookkeeping.
The main model receives the location and counts, and can read saved task context or make explicitly requested corrections through the tool.
Tracking does not authorize starting tasks or resuming unrelated work.
Enabling tracking also enables additional model calls and their token charges.

Storage follows the user-selected folder-name layout:

```text
~/.config/ai-sessions/<current-directory>/progress.json
```

The directory name comes from the canonical working directory, with symlinks resolved.
For `/Users/zaher/Code/my-project`, the location is `~/.config/ai-sessions/my-project/progress.json`.
The file records the full canonical project path.
A different project with the same folder name is refused rather than sharing or replacing its progress.
Moving a project also changes its identity; migration is not automatic.
The location is deliberately independent of `XDG_CONFIG_HOME`.

## Background model

Without an override, the updater uses `defaultProvider` and `defaultModel` from Pi's effective settings.
It does not use the current session model or automatically select a substitute.
Both defaults must be configured when no override is present.

To select a separate model, merge this optional key into `~/.pi/agent/settings.json`, replacing the placeholder with a registered provider and model:

```json
{
  "progress": {
    "model": "your-provider/your-model-id"
  }
}
```

The first slash separates the provider from the model ID; model IDs can contain further slashes.
Omit `progress.model` to use the configured defaults.
An empty string, malformed value, or unknown setting inside `progress` is an error, not a request for fallback.
Pi supplies merged settings, so trusted project `.pi/settings.json` values can override user settings.
Run `/reload` after editing settings.
Installation does not change settings or choose an override for you.

### Scheduling and failure handling

The updater schedules work at `agent_settled`, after automatic retries and continuations have finished, not after each tool turn.
Aborted runs and incomplete final replies are skipped.
The event handler does not wait for the provider call, so the reply and subsequent input do not wait for progress maintenance.
Only one logical update runs at a time, and queued settlements coalesce to the newest snapshot.
A new prompt, branch navigation, reload, or session replacement invalidates pending work and cancels active requests.
Graceful quit instead stops accepting new updates and waits for the active and latest queued update, including its atomic write, before Pi exits.
User input invalidates at the input boundary, before any pre-prompt compaction delay.
Older responses cannot overwrite newer conversation state.
Providers are asked to cancel, but a provider that ignores cancellation can continue processing and billing after its result has been discarded.

Each request has a 60-second deadline, no provider retries, and an output allowance of at most 4,096 tokens.
Missing models, authentication failures, malformed output, and oversized context leave progress unchanged and produce a warning.
Warnings use Pi notifications when available and stderr otherwise; provider error bodies and raw responses are not echoed.
During quit, waiting notices and failures go to stderr because Pi stops the interactive TUI before running shutdown handlers.
There is no automatic retry loop or alternate model.
A later finished reply schedules a fresh attempt.
A revision conflict also discards the proposal and warns instead of replaying stale edits.

The file may briefly lag, and rapid input can cancel an update before it is saved.
Normal quit, including one-shot print-mode shutdown, waits for pending work to finish.
Provider requests retain their existing 60-second deadline; failures or timeouts warn and allow exit without claiming the update was saved.
Reload and session replacement still cancel pending work.
Forced termination, crashes, and terminal failures that bypass normal shutdown cannot be delayed.
The CLI and manual tool remain available when an immediate checkpoint is needed.

### Context, privacy, and usage

The selected provider receives existing task records plus a bounded selection of recent user text and completed assistant replies.
Pi's context edits and compaction are respected.
Hidden reasoning, tool arguments/results, images, system instructions, custom messages, and compaction summaries are not copied into this request.
The transcript selection includes at most 24 messages, 6,000 characters per message, and 16,000 characters total, with truncation disclosed to the model.
The complete request data must fit a 64,000-byte budget, reduced further for small model context windows.
Oversized saved progress is refused rather than sending a partial task snapshot.
Decisions available only in tool output or omitted history can therefore be missed.

Common credential assignments, authorization headers, private keys, signed-URL credentials, and recognizable token formats are redacted before transmission and from generated updates.
This is heuristic protection, not a guarantee that every secret or personal detail will be detected.
Do not include sensitive information in tracked task text, and select a provider appropriate for the conversation's privacy requirements.

Provider-reported usage is stored in non-context Pi custom entries named `progress-usage` with provider/model attribution.
These entries do not include prompts or model output.
Pi 1.4 has no public extension API for adding idle background usage to session totals, so these charges are **not included in `/session` totals**.
Calls cancelled before a response may be billed without reported usage.

### Applying proposals

The model has no tools or filesystem access.
It is instructed to return one minified JSON object containing task patches, on a single line without Markdown fences or whitespace outside string values.
Existing IDs must resolve to their saved task or step; `id: null` requests a writer-assigned ID.
Omitted records are preserved, and patches cannot delete or reorder tasks, move steps, or supply invented IDs.
New steps can carry their evidenced status in the same commit that creates them.

All patches are validated with the shared document rules and committed together under the same lock and expected-revision check as CLI writes.
An invalid patch rejects the entire proposal.
An empty or identical proposal leaves the revision, timestamp, and bytes unchanged.
The persisted version-1 format and public CLI action protocol are unchanged.

## File format, version 1

Tool and CLI responses and newly written progress files use compact JSON, preserving whitespace inside string values.
CLI responses and saved files retain a terminating newline.
Existing pretty-printed version-1 files remain readable and are compacted on the next mutation, not on reads or no-op updates.
The example below is expanded for readability.

```json
{
  "version": 1,
  "project": "/work/my-project",
  "revision": 1,
  "updated_at": "2026-10-29T12:00:00.000Z",
  "tasks": [
    {
      "id": "task-example",
      "title": "Add project search",
      "description": "Use the existing local index because the user ruled out an external search service.",
      "steps": [
        {
          "id": "step-example",
          "description": "Implement the query handler",
          "status": "blocked",
          "blocked_by": "Waiting for the approved query syntax"
        }
      ]
    }
  ]
}
```

Each task needs a title, a description explaining agreed decisions and rationale, and at least one step.
Store useful results and verification evidence in step descriptions when they help the next model continue.
Do not record secrets or full conversation transcripts.
Descriptions are task data, not instructions or authorization.

The writer assigns stable UUID-based IDs.
Each successful mutation increments the document-wide revision and records a UTC timestamp.
Unknown fields, unsupported versions, duplicate IDs, invalid UTF-8, and malformed documents are rejected without repair.
Requests and documents have a 1 MiB limit.

| Step status | Meaning | `blocked_by` |
| --- | --- | --- |
| `null` | Not started | `null` |
| `"working"` | Work has started | `null` |
| `"blocked"` | Work cannot proceed | Nonempty reason or referenced step ID |
| `"completed"` | Required work and checks are done | `null` |

A blocker is descriptive text; it does not schedule dependencies or automatically unblock a step.
Updating status requires sending both `status` and `blocked_by` together.
Completed tasks remain in the file.
There are no task deletion, automatic archival, or assignment commands.

## Use from another harness

The CLI uses only Node's standard library and requires Node 22.19 or later.
It does not require Pi to be running.
Keep `cli.ts`, `store.ts`, and `package.json` together if copying the writer elsewhere.

Read the current state:

```bash
printf '%s\n' '{"action":"read"}' |
  node ~/.pi/agent/extensions/progress/cli.ts --cwd /path/to/project
```

Explicitly enable a directory through the CLI:

```bash
printf '%s\n' '{"action":"start"}' |
  node ~/.pi/agent/extensions/progress/cli.ts --cwd /path/to/project
```

Add a task after reading revision `0`:

```bash
printf '%s\n' '{"action":"add_task","expected_revision":0,"title":"Add search","description":"Use the existing index to avoid a new service.","steps":["Implement search","Verify supported queries"]}' |
  node ~/.pi/agent/extensions/progress/cli.ts --cwd /path/to/project
```

The CLI accepts one JSON request on stdin and defaults to its current directory when `--cwd` is omitted.
Success exits with code `0` and returns `{ "path": "...", "document": ... }` on stdout.
A read before activation returns `document: null` without creating directories.
Failure exits with code `1` and returns `{ "code": "...", "message": "..." }` on stderr.

| Action | Required fields beyond `action` | Optional fields |
| --- | --- | --- |
| `read` | None | None |
| `start` | None; CLI or user command only | None |
| `add_task` | `expected_revision`, `title`, `description`, `steps` as an array of descriptions | None |
| `update_task` | `expected_revision`, `task_id`, at least one field to update | `title`, `description` |
| `add_step` | `expected_revision`, `task_id`, `description` | None |
| `update_step` | `expected_revision`, `task_id`, `step_id`, at least one update | `description`, or both `status` and `blocked_by` |

New steps start with `status: null` and `blocked_by: null`.
Use IDs returned by the writer, not array positions.
The Pi tool accepts the same requests except `start`.
It returns the full document as structured data; large model-facing text is truncated with the full file path provided.

## Concurrent writers and recovery

All writers must use the shared store through this CLI, the Pi tool, or the background updater.
Direct edits, writes from unrelated scripts, and manual lock removal during active work bypass the concurrency guarantees.
The protocol targets cooperating processes on a local macOS or Linux filesystem, not network filesystems or hostile processes sharing the same account.

Each mutation acquires `progress.lock` with exclusive file creation, reads and validates the latest file, and checks `expected_revision` while holding the lock.
It writes a private temporary file, syncs it, renames it over `progress.json`, and syncs the directory before returning success.
Initialization also syncs parent directory entries.
Readers see the previous or replacement document without needing the lock.
New storage directories use mode `0700`; progress files and lock files use `0600`.
Storage-directory symlinks, including a replaced `.config` parent, and progress-file symlinks are refused.
If lock ownership cannot be verified during cleanup, the descriptor is closed and the lock is left for explicit inspection.

`CONFLICT` means another writer changed the revision.
Read again, inspect the current tasks, and reconsider the intended change.
Even updates to different tasks can conflict because the revision covers the whole document.
Do not blindly retry a stale update or replace the entire file.
This protocol prevents lost writes; it does not allocate tasks or prevent two models from choosing the same work.

Lock contention waits for up to two seconds, then returns `LOCKED`.
An interrupted or killed process can leave a lock file behind.
Locks are never stolen based on age or a PID check.
Inspect the lock's PID, hostname, and timestamp, stop all writers, and confirm no writer remains before removing that lock manually.
A crashed writer can also leave a `.progress-*.tmp` file; remove it only after stopping writers and inspecting the valid `progress.json`.

`DURABILITY_UNCERTAIN` means replacement succeeded but directory sync failed.
The new revision may already be visible; read it before deciding whether to retry.
Any I/O or cancellation error near commit also requires a fresh read.
Malformed or unsupported files are preserved for explicit recovery, never silently reset.

To disable tracking while retaining its history, stop all writers and move `progress.json` to a backup location.
Subsequent runs see tracking as off until it is explicitly started again.
Do not move or remove the file while any writer is active.

## Verification

Run the storage, background-updater, failure-path, and Pi loader integration suites from `~/.pi/agent`:

```bash
PI_PACKAGE_ROOT="$HOME/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent" \
  node --test tests/progress*.test.mjs
```

Set `PI_PACKAGE_ROOT` to the installed Pi package path after upgrades.
Tests use isolated temporary homes and projects, including real concurrent CLI processes.
They cover settings merging, settlement scheduling, context filtering, cancellation, coalescing, conflicts, atomic patches, graceful quit draining, and injected I/O failures.
They do not enable tracking in the actual project or call a model provider.
A separate isolated live smoke test verified a minified response and compact saved update with `openrouter/deepseek/deepseek-v4.1-flash`, using synthetic conversation data and temporary storage.
That single request does not establish reliability across other models or conversations.
Interactive notifications, minimum-Node compatibility, host-power-loss durability, and cross-platform operation have not been verified.
