# Plan 004: Surface nested `codemode` tool calls in `/trace` and sync `README.md`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2545142..HEAD -- README.md shared/display.ts`
> (`trace/index.ts` is expected to have the changes from Plan 003.)
> If `README.md` or `shared/display.ts` changed since commit `2545142`, compare
> the "Current state" excerpts before proceeding; on an unexpected mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-worker-board-auto-open-and-schemas.md`, `plans/003-trace-filtering-previews-and-loop.md`
- **Category**: dx
- **Planned at**: commit `2545142`, 2026-11-21

## Why this matters

In Pi 1.6 (`dist/extensions/codemode/execute.js`), tools invoked inside a `codemode` script (`tools.bash(...)`, `tools.read(...)`, MCP tools) do not produce top-level `toolResult` entries on the session branch — instead, `codemode` records them on its own `toolResult.details.calls` array (`{ id, name, args, status: "ok" | "error" | "cancelled" | "running", error?, durationMs? }`). When a script catches a tool failure (`Promise.allSettled` / `try-catch`), the parent `codemode` `toolResult` has `isError: false`, so `/trace failed` and `/trace [failed] bash` completely miss nested failures, and inspecting a `codemode` entry hides which nested calls failed. Surfacing `details.calls` in `/trace` and updating `README.md` to match Plans 001–004 completes both extensions and aligns the documentation with reality.

## Current state

- `codemode` persisted `toolResult.details` shape in Pi 1.6 (`execute.js:456-477`):
  ```ts
  // msg.toolName === "codemode", msg.details:
  {
    calls?: Array<{
      id?: string;
      name?: string;
      args?: string; // preview string produced by codemode
      status?: "ok" | "error" | "cancelled" | "running";
      durationMs?: number;
      error?: string;
    }>
  }
  ```
- `README.md` at `HEAD` (`2545142`):
  - Lines 18–19 (overview table):
    ```markdown
    | [Trace](#trace) | `trace/index.ts` | `/trace [failed [tool]]` | `tui`, `rpc` (with UI) | No | Browses recorded tool results and failures on the active branch with bounded, redacted output tails. |
    | [Worker board](#worker-board) | `worker-board/index.ts` | `/workers [page\|hide]`, pinned widget | `tui`, `rpc` (with UI) | No | Shows live and last-recorded worker assignments, blockers, and outcomes from a parent `subagent` tool. |
    ```
  - Lines 36–41 (`## Installation` local checkout example) and lines 327–420 (`## Trace`, `## Worker board`, and the stale `## Testing and verification` section referencing deleted `node --test .../tests/*.test.mjs` paths).
- **Important merge-hygiene constraint**: Do **not** touch line 16 or any lines between lines 42 and 326 (`## Exit` through `## RTK gain`, especially `## RTK for other Pi tools`) so this branch merges with zero conflicts alongside separate uncommitted `rtk-pi-extended` edits in the maintainer's main working tree.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck + Lint | `npm run check` | exit 0, 0 errors |
| Disposable unit tests | `node --test .verification/trace-codemode.test.ts` | all tests pass |

## Scope

**In scope** (the only files you should modify):
- `trace/index.ts`
- `README.md` (lines 18–19, lines 36–41, and lines 327–420 ONLY)

**Out of scope** (do NOT touch):
- `README.md` line 16 or lines 42–326 (especially `## RTK for other Pi tools`)
- `shared/display.ts`, `worker-board/*`, `package.json`, `tsconfig.json`
- Committed test files — delete `.verification/` before finishing.

## Git workflow

- Branch: `advisor/001-004-trace-worker-board`
- Commit once all steps and checks pass (e.g. `Surface nested codemode calls in /trace and update README`).
- Do NOT push or open a PR.

## Steps

### Step 1: Extract and match nested `codemode` calls in `trace/index.ts`

In `trace/index.ts`:
1. Add a small helper `codemodeCalls(msg: ToolResultMessage)` that returns validated nested call items when `msg.toolName === "codemode"` and `typeof msg.details === "object" && msg.details !== null && "calls" in msg.details && Array.isArray((msg.details as Record<string, unknown>).calls)`:
   - Each valid entry is a non-null plain object with `typeof name === "string" && name.length > 0`.
   - Classify nested call failure as `call.status === "error" || call.status === "cancelled"`.
2. Update `/trace` filtering logic for each `toolResult` entry:
   - For non-`codemode` entries (or `codemode` without `details.calls`), keep exact existing matching (`(!failedOnly || msg.isError === true) && (!tool || msg.toolName === tool)`).
   - For `codemode` entries with nested `calls`:
     - Direct match on `codemode`: `(!failedOnly || msg.isError === true || calls.some(isFailedCall)) && (!tool || tool === "codemode")`.
     - Nested tool match (`tool && tool !== "codemode"`): match if `calls.some((c) => c.name === tool && (!failedOnly || isFailedCall(c)))`!
3. Update row status & preview for `codemode` entries:
   - Status label: `msg.isError ? "failed" : hasFailedNestedCall ? "nested-err" : "ok"`.
   - Use `"warning"` notification level when `selected.msg.isError || selected.hasFailedNestedCall`.
   - When `calls.length > 0` and nested calls failed (or a nested `tool` filter matched), include a compact sanitized nested count/tool hint (e.g. `[2/3 err]` or `[bash]`) via `displayLabel` alongside the preview.
4. Update `diagnostic(msg: ToolResultMessage): string`:
   - Keep existing bounded 16,384-unit `content` text assembly + `displayTail(...)`.
   - When `codemodeCalls(msg)` is non-empty, prepend a compact sanitized `[Nested calls]` summary (capped to the last 10 nested calls, formatting each as `- ${status} ${displayLabel(name, 32)}${args ? ` (${displayLabel(args, 40)})` : ""}${error ? `: ${displayLabel(error, 120)}` : ""}`) before the output tail so caught inner tool failures are immediately visible when inspecting a `codemode` result!

**Verify**: `npm run check` → exits 0.

### Step 2: Update `README.md` (`## Trace`, `## Worker board`, table rows, and `npm run check`)

Edit `README.md` **only** in lines 18–19, lines 36–41, and lines 327–420:
1. **Overview table (lines 18–19)**:
   - Update Trace surface to `/trace [failed] [tool]` and mention call previews + nested `codemode` call inspection.
   - Mention that Worker board auto-opens on live worker/workflow runs (unless hidden) and supports both Pi's example runner and `pi-subagents`.
2. **Local checkout verification (`## Installation`, right after line 40)**:
   - Under `pi -e ./trace/index.ts -e ./worker-board/index.ts`, add a brief note + snippet for `npm run check` (explaining that it runs `tsc --noEmit` against local `node_modules` or the installed Pi release in `~/.pi/agent/install` plus `biome lint`).
3. **`## Trace` section**:
   - Document `/trace`, `/trace <tool>`, `/trace failed`, and `/trace failed <tool>`.
   - Document sanitized call-argument previews in picker rows, the persistent picker loop (`Esc`/cancel closes), and nested `codemode` `details.calls` inspection/filtering (`nested-err`, `[Nested calls]`).
   - Update "What Trace never inspects" to accurately note that `details` payloads are ignored *except* `codemode`'s `details.calls` summary, while other nested sub-tool calls without parent-branch entries or `codemode` records remain excluded.
4. **`## Worker board` section**:
   - Document auto-open on `tool_execution_start` for worker/workflow batches (suppressed for the rest of the current batch by `/workers hide`, reset on the next settled turn; `management` actions do not auto-open a closed board) and manual `/workers [page|hide]`.
   - Document compatibility with both Pi's example `subagent` schema (`status`, `messages`, `blocked`/`blocker`) and `pi-subagents` schemas (`exitCode`, `toolCalls`, `workflow` / `workflowChildren`, `asyncId`, and `management`), including `#<ref>/<slot> Unsupported worker report.` and `last reported ...` historical labels.
5. **Remove stale `## Testing and verification` section (lines 400–420)**:
   - Delete lines 400–420 (`---` + `## Testing and verification` referencing deleted `shared/tests/*.test.ts` etc.) cleanly so `## Worker board` is followed directly by `---\n\n## Update or remove`.

**Verify**:
- `npm run check` → exits 0
- `git diff -U0 HEAD -- README.md` → confirms zero hunks touch line 16 or lines 42–326 (`## RTK for other Pi tools` untouched!).

### Step 3: Run disposable tests in `.verification/` + Pi `loadExtensions` smoke check, then clean up

1. Temporarily symlink `node_modules` to Pi's release `node_modules`.
2. Create `.verification/trace-codemode.test.ts` testing:
   - `codemode` with `isError: false` and a failed nested `bash` call in `details.calls` appears in `/trace`, `/trace failed`, `/trace bash`, and `/trace failed bash`, and does **not** appear in `/trace failed read`.
   - Selecting that `codemode` entry includes `[Nested calls]` with redacted error text (`Bearer tok_secret` -> `Bearer [REDACTED]`) and uses `"warning"` notification level.
   - Smoke-load `trace/index.ts` and `worker-board/index.ts` via `loadExtensions` from `@earendil-works/pi-coding-agent` and assert `errors.length === 0`.
3. Run `node --test .verification/trace-codemode.test.ts`.
4. Delete `.verification/` and `node_modules` (`rm -rf .verification node_modules`).

**Verify**: `rm -rf .verification node_modules && npm run check && test ! -e .verification && test ! -e node_modules && echo CLEAN` → `CLEAN`

## Test plan

- Disposable `.verification/trace-codemode.test.ts` + `loadExtensions` smoke test in Step 3, deleted before commit.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] Disposable `.verification/trace-codemode.test.ts` (including `loadExtensions` smoke check) ran and passed 100% before deletion
- [ ] `test ! -e .verification && test ! -e node_modules` exits 0
- [ ] `git status --ignored -s` shows no `.verification/` or `node_modules` left in the worktree
- [ ] Only `trace/index.ts` and `README.md` are modified in this commit, and `README.md` line 16 and lines 42–326 are untouched

## STOP conditions

- `README.md` hunks touch line 16 or `## RTK for other Pi tools` (lines 42–326).
- `loadExtensions` reports any load error on `trace/index.ts` or `worker-board/index.ts`.
- Any check fails twice after a minimal fix attempt.

## Maintenance notes

- Only `codemode`'s structured `details.calls` array is inspected in `trace/index.ts`; arbitrary `details` blobs on other tools stay excluded so large or unredacted structured payloads do not flood notifications.
