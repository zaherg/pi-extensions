# Plan 002: Auto-open worker-board and support real subagent runner payloads

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2545142..HEAD -- worker-board/index.ts worker-board/report.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `2545142`, 2026-11-21

## Why this matters

`worker-board` currently fails in two ways during real Pi sessions:
1. `draw()` in `worker-board/index.ts:43` exits immediately when `!page && !requested`, so `tool_execution_start` / `update` / `end` never display the board unless the user manually runs `/workers` in every session (`/new`, `/resume`, `/fork`, and `/reload` reset `page = 0`).
2. `workerRows()` in `worker-board/report.ts:23-25,62-80,89-129` only accepts `details.mode` in `{"single", "parallel", "chain"}` and requires `raw.status` in `{"blocked", "failed", "aborted", "running", "pending", "completed"}` plus `raw.messages` for last-tool hints. Real `pi-subagents` results emit `details.mode` in `{"single", "workflow", "management"}`, omit `raw.status` in favor of `raw.exitCode` (`0` vs non-zero) and `raw.toolCalls` (`Array<{ text?: string }>`), and return `details.results: []` with `details.asyncId` or `details.workflowChildren` on async/workflow launches — causing 100% of real `subagent` calls to render `Unsupported` / `No compatible worker report.` / `No worker outcome reported.` In addition, malformed worker entries at `report.ts:96` use `note(...)` (`#ref`) instead of `slot` (`#ref/N`).

## Current state

- `worker-board/index.ts` (lines 37–154):
  ```ts
  export default function workerBoard(pi: ExtensionAPI): void {
  	const batch = new Map<string, { args: unknown; rows: Row[] }>();
  	let page = 0;
  	let previous = "";

  	function draw(ctx: ExtensionContext, requested?: number): void {
  		if (!ctx.hasUI || (!page && !requested)) return;
  		const rows = batch.size
  			? [...batch.values()].flatMap((call) => call.rows)
  			: latestBatch(ctx.sessionManager.getBranch());
  ...
  	function hide(ctx: ExtensionContext): void {
  		if (page && ctx.hasUI) ctx.ui.setWidget(KEY, undefined);
  		page = 0;
  		previous = "";
  	}

  	pi.registerCommand("workers", {
  		description: "Show the subagent worker board: /workers [page|hide]",
  		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
  			if (!ctx.hasUI)
  				throw new Error("/workers requires an interactive Pi or RPC UI.");
  			const value = args.trim();
  			if (value === "hide") hide(ctx);
  			else if (!value || /^[1-9]\d{0,8}$/.test(value))
  				draw(ctx, Number(value || 1));
  			else ctx.ui.notify("Usage: /workers [page|hide]", "warning");
  		},
  	});

  	// Ignore nested tool calls because they have no independent result on the parent branch.
  	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext): void => {
  		if (
  			!ctx.hasUI ||
  			event.toolName !== "subagent" ||
  			event.parentToolCallId !== undefined
  		)
  			return;
  		const callArgs: unknown = event.args;
  		batch.set(event.toolCallId, {
  			args: callArgs,
  			rows: workerRows(event.toolCallId, callArgs, undefined, "live"),
  		});
  		draw(ctx);
  	});
  ...
  	function settled(ctx: ExtensionContext): void {
  		batch.clear();
  		draw(ctx);
  	}
  ```
- `worker-board/report.ts` (lines 13–133):
  ```ts
  const priority = {
  	blocked: 0,
  	failed: 0,
  	aborted: 1,
  	running: 2,
  	pending: 3,
  	completed: 4,
  } as const;
  const record = (v: unknown): v is Record<string, unknown> =>
  	typeof v === "object" && v !== null && !Array.isArray(v);
  const modes = new Set<unknown>(["single", "parallel", "chain"]);
  const knownStatus = (v: unknown): v is keyof typeof priority =>
  	typeof v === "string" && Object.hasOwn(priority, v);
  ...
  	if (!details.results.length) {
  		return [
  			phase === "failed"
  				? note("Call failed; no worker outcome reported.", 0)
  				: phase === "live"
  					? note("Awaiting worker report.")
  					: note("No worker outcome reported."),
  		];
  	}
  ...
  	const rows = details.results.map((raw: unknown, i: number): Row => {
  		const slot = `${ref}/${i + 1}`;
  		const agent =
  			record(raw) && typeof raw.agent === "string"
  				? displayLabel(raw.agent, 32)
  				: "";
  		if (!record(raw) || !agent || !knownStatus(raw.status))
  			return note(`Worker ${i + 1}: unsupported report.`);
  ```
- Conventions to match:
  - Sanitize every external/model-supplied string via `displayLabel(value, limit)` from `../shared/display.ts`.
  - Keep strict TypeScript compatibility (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, explicit parameter/return types).
  - Preserve honest historical state: persisted (`phase !== "live"`) `"running"` or `"pending"` states must render with `last reported ...` so saved snapshots are never mistaken for live OS processes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck + Lint | `npm run check` | exit 0, 0 errors |
| Disposable unit tests | `node --test .verification/board.test.ts` (with temporary `node_modules` symlink to Pi's `node_modules` if needed) | all tests pass |

## Scope

**In scope** (the only files you should modify):
- `worker-board/report.ts`
- `worker-board/index.ts`

**Out of scope** (do NOT touch):
- `shared/display.ts`
- `trace/index.ts`
- `README.md` (updated once in Plan 004)
- Committed test files — any `.verification/` files and temporary `node_modules` symlinks MUST be deleted before finishing.

## Git workflow

- Branch: `advisor/001-004-trace-worker-board`
- Commit once all steps and checks pass (e.g. `Auto-open worker-board and support pi-subagents reports`).
- Do NOT push or open a PR.

## Steps

### Step 1: Support `pi-subagents` schemas and fix slot formatting in `worker-board/report.ts`

Update `worker-board/report.ts` with minimal, readable helpers:

1. **Expand `modes`**:
   `const modes = new Set<unknown>(["single", "parallel", "chain", "workflow", "management"]);`
2. **Infer worker status (`inferStatus`)**:
   - If `knownStatus(raw.status)`, use `raw.status`.
   - Else if `typeof raw.exitCode === "number"`, return `raw.exitCode === 0 ? "completed" : "failed"`.
   - Else if `phase === "live"`, return `"running"`.
   - Otherwise return `undefined` (unsupported report).
3. **Fallback `lastTool` to `raw.toolCalls`**:
   - Keep `lastTool(raw.messages)` first.
   - If that returns `""` and `Array.isArray(raw.toolCalls)`, scan backward from `raw.toolCalls.length - 1` to `0`: for each `entry` where `record(entry) && typeof entry.text === "string"`, sanitize with `displayLabel(entry.text, 32)` and return the first non-empty string.
4. **Fix unsupported worker row slot reference**:
   - When `!record(raw) || !agent || !status`, return `{ priority: 1, text: `${slot} Unsupported worker report.` }` so the `#ref/<slot>` identifier matches valid worker rows.
5. **Handle `workflow`, `asyncId`, and `management` when `details.results.length === 0`**:
   - Before the generic empty-`results` fallback:
     - **`details.mode === "workflow"`**:
       - Read `wfState = record(details.workflowChildren) && typeof details.workflowChildren.workflowState === "string" ? displayLabel(details.workflowChildren.workflowState, 24) : ""`.
       - Determine effective status key (`"failed"` when `phase === "failed"` or `wfState === "failed"`, `"running"` when `phase === "live"` or `wfState === "running"` or `typeof details.asyncId === "string"`, else `"completed"`).
       - Render status label with `phase !== "live" && statusKey === "running" ? "last reported running" : statusKey`, target name `displayLabel(record(args) && typeof args.workflow === "string" ? args.workflow : "workflow", 32) || "workflow"`, optional mission/task preview from `record(args) && typeof args.mission === "string" ? displayLabel(args.mission, 64) : ""`, and `async` tag if `typeof details.asyncId === "string"`, formatted as `${statusLabel} ${name} ${ref}` joined by `" · "` with mission/async info.
     - **`typeof details.asyncId === "string"`** (e.g. `single` with `async: true`):
       - Read `agent = record(args) && typeof args.agent === "string" ? displayLabel(args.agent, 32) : ""` (fallback `"worker"`) and `task = record(args) && typeof args.task === "string" ? displayLabel(args.task, 64) : ""`.
       - Status key is `phase === "failed" ? "failed" : "running"`; status label is `phase === "failed" ? "failed" : phase === "live" ? "running (async)" : "last reported async"`.
       - Return `[{ priority: phase === "failed" ? 0 : priority.running, text: [`${statusLabel} ${agent} ${ref}`, task].filter(Boolean).join(" · ") }]`.
     - **`details.mode === "management"`**:
       - Read `action = record(args) && typeof args.action === "string" ? displayLabel(args.action, 24) : ""` (fallback `"action"`).
       - Read optional state from `record(details.lifecycleStatus) && record(details.lifecycleStatus.processTerminal) && typeof details.lifecycleStatus.processTerminal.state === "string" ? displayLabel(details.lifecycleStatus.processTerminal.state, 24) : record(details.steering) && typeof details.steering.state === "string" ? displayLabel(details.steering.state, 24) : ""`.
       - Return `[{ priority: phase === "failed" ? 0 : priority.completed, text: [`${phase === "failed" ? "failed" : "completed"} management:${action} ${ref}`, state && `state: ${state}`].filter(Boolean).join(" · ") }]`.
   - Keep existing behavior (`"Call failed; no worker outcome reported."` / `"Awaiting worker report."` / `"No worker outcome reported."`) for all other empty `results: []` cases (such as declining Pi's example confirmation prompt where `mode: "single"`, `results: []`, and no `asyncId`).

**Verify**: `npm run check` → exits 0.

### Step 2: Auto-open live batches unless hidden in `worker-board/index.ts`

Update `worker-board/index.ts`:
1. Add `let hidden = false;` alongside `page` and `previous`.
2. In `/workers` command handler:
   - When `value === "hide"`: set `hidden = true;` and call `hide(ctx);`.
   - When `!value || /^[1-9]\d{0,8}$/.test(value)`: set `hidden = false;` and call `draw(ctx, Number(value || 1));`.
3. In `tool_execution_start`:
   - Skip `management` noise from auto-opening when the board is closed (`const isManagement = typeof callArgs === "object" && callArgs !== null && "action" in callArgs && !("agent" in callArgs) && !("tasks" in callArgs) && !("chain" in callArgs) && !("workflow" in callArgs) && !("workflowScript" in callArgs);`).
   - If `!page && !hidden && !isManagement`, set `page = 1;` before `draw(ctx);` so delegated worker/workflow runs automatically pin the board on page 1!
4. In `settled(ctx)` and `session_shutdown`:
   - Reset `hidden = false;` so hiding one noisy batch does not permanently silence future turns' worker batches (while keeping an already-open board visible across `settled` on `last recorded batch`, and hiding on `session_shutdown` as before).

**Verify**: `npm run check` → exits 0.

### Step 3: Run disposable unit & contract tests in `.verification/` and delete them

1. Temporarily symlink `node_modules` to Pi's release `node_modules` (`ln -sfn "$HOME/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules" node_modules`) so Node can resolve `@earendil-works/pi-tui` at test runtime.
2. Create `.verification/board.test.ts` using `node:test` and `node:assert/strict` testing:
   - Pi 1.6 example `SingleResult` (`status`, `messages`, `blocked` + `blocker`, `chain` prompt safety, empty `results: []` decline path -> `"No worker outcome reported."`).
   - `pi-subagents` `single` result (`status: undefined`, `exitCode: 0` -> `completed`, `exitCode: 1` -> `failed`, `toolCalls: [{ text: "edit foo.ts" }]` -> `last: edit foo.ts`).
   - `pi-subagents` async `single` (`results: []`, `asyncId: "uuid"`) -> `running (async)` live and `last reported async` settled.
   - `pi-subagents` `workflow` (`results: []`, `workflowChildren: { workflowState: "running" }`, `args: { mission: "Audit repo" }`) and `management` (`args: { action: "status" }`).
   - Malformed worker slot uses `#ref/2 Unsupported worker report.`.
   - `workerBoard` extension lifecycle: `tool_execution_start` auto-opens widget without prior `/workers`; `/workers hide` closes widget and suppresses updates for the rest of that batch; `turn_start` (`settled`) resets `hidden` so the next batch auto-opens again; `action: "list"` management call alone does not pop open a closed board.
3. Run `node --test .verification/board.test.ts` and confirm 100% pass.
4. Remove `.verification/` and the temporary `node_modules` symlink (`rm -rf .verification node_modules`).

**Verify**: `rm -rf .verification node_modules && npm run check && test ! -e .verification && test ! -e node_modules && echo CLEAN` → `CLEAN`

## Test plan

- Disposable `.verification/board.test.ts` covering all 6 bullet groups in Step 3, executed via `node --test` and deleted immediately after passing.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] Disposable `.verification/board.test.ts` ran and passed 100% of assertions before deletion
- [ ] `test ! -e .verification && test ! -e node_modules` exits 0
- [ ] Only `worker-board/index.ts` and `worker-board/report.ts` are modified in this commit (`git diff --name-only HEAD~1..HEAD`)

## STOP conditions

- `worker-board/index.ts` or `worker-board/report.ts` differs from "Current state".
- Any test fails twice after a minimal fix attempt.
- Changes require modifying `shared/display.ts` or any file outside `worker-board/`.

## Maintenance notes

- Persisted `async` / `workflow` states must always include `last reported` when `phase !== "live"` so resumed sessions never claim background processes are still alive.
- Management calls (`{ action: "list" | "status" | "steer" }`) intentionally do not auto-open a closed board, though they still render if the board is already open or opened via `/workers`.
