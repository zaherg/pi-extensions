# Plan 003: Add `/trace [failed] [tool]` filtering, call previews, and persistent picker loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2545142..HEAD -- trace/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-verification-baseline.md`
- **Category**: dx
- **Planned at**: commit `2545142`, 2026-11-21

## Why this matters

In daily Pi sessions, `/trace` has three usability gaps compared to the Antigravity builtin `describeToolCall` workflow:
1. `/trace <tool>` (for example `/trace bash` or `/trace codemode`) is rejected with a usage warning because `trace/index.ts:67-71` only allows a `<tool>` argument after `failed`.
2. Picker rows only show `<index>. ok|failed <tool> · <timestamp> · #<id>` (`trace/index.ts:95-96`), never pairing `toolCallId` with the assistant's `toolCall.arguments`. When 15 `bash` or `read` calls run in a turn, every row looks identical.
3. Selecting an item calls `ctx.ui.notify(...)` and immediately `return`s (`trace/index.ts:123-124`), closing `/trace` and forcing the user to re-run `/trace` and re-paginate from page 1 to check a second entry. Keeping the `for (;;)` selector loop open at the current `offset` until the user cancels (`Esc` / empty pick) makes multi-entry inspection effortless in both TUI and RPC modes.

## Current state

- `trace/index.ts` (lines 61–129):
  ```ts
  	pi.registerCommand("trace", {
  		description:
  			"Inspect recorded tool results on this branch: /trace [failed [tool]]",
  		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
  			if (!ctx.hasUI)
  				throw new Error("/trace requires an interactive Pi or RPC UI.");
  			const [filter, tool, extra] = args.trim().split(/\s+/u);
  			if ((filter && filter !== "failed") || extra) {
  				ctx.ui.notify("Usage: /trace [failed [tool]]", "warning");
  				return;
  			}
  			const results = ctx.sessionManager
  				.getBranch()
  				.flatMap((entry: SessionEntry): TraceItem[] => {
  					if (entry.type !== "message" || entry.message.role !== "toolResult")
  						return [];
  					const msg = entry.message;
  					if (
  						(filter && msg.isError !== true) ||
  						(tool && msg.toolName !== tool)
  					)
  						return [];
  					return [{ id: entry.id, time: entry.timestamp, msg }];
  				})
  				.reverse();
  			if (!results.length) {
  				ctx.ui.notify("No matching tool results on this branch.", "info");
  				return;
  			}
  			const { signal } = branch;
  			let offset = 0;
  			for (;;) {
  				const page = results.slice(offset, offset + PAGE_SIZE);
  				const labels = page.map(
  					({ id, time, msg }: TraceItem, i: number): string =>
  						`${offset + i + 1}. ${msg.isError ? "failed" : "ok"} ${displayLabel(msg.toolName, 64) || "?"} · ${displayLabel(time, 32) || "?"} · #${displayLabel(id, 36) || "?"}`,
  				);
  				const options = [...labels];
  				if (offset) options.push(NEWER);
  				if (offset + page.length < results.length) options.push(OLDER);
  				const pick = await ctx.ui.select(
  					`Tool trace (${offset + 1}-${offset + page.length} of ${results.length})`,
  					options,
  					{ signal },
  				);
  				if (signal.aborted || !pick || !options.includes(pick)) return;
  				if (pick === NEWER) offset -= PAGE_SIZE;
  				else if (pick === OLDER) offset += PAGE_SIZE;
  				else {
  					const selected = page[labels.indexOf(pick)];
  					if (!selected) return;
  					if (
  						!ctx.sessionManager
  							.getBranch()
  							.some((entry: SessionEntry) => entry.id === selected.id)
  					) {
  						ctx.ui.notify(
  							"The selected result is no longer on this branch.",
  							"warning",
  						);
  						return;
  					}
  					ctx.ui.notify(`${pick}\n${diagnostic(selected.msg.content)}`, "info");
  					return;
  				}
  			}
  		},
  	});
  ```
- Conventions & security invariants to preserve:
  - **Redaction boundary**: every preview extracted from `toolCall.arguments` MUST pass through `displayLabel(value, 40)` from `../shared/display.ts` so inline secrets (`Bearer ...`, `API_KEY=...`, `https://user:pass@host`, ANSI escapes, newlines) are stripped and redacted before reaching `ctx.ui.select` or `ctx.ui.notify`.
  - **Branch safety**: keep `session_tree` and `session_shutdown` `AbortController` cancellation AND the `getBranch().some((entry) => entry.id === selected.id)` check before showing diagnostics; if the selected entry is no longer on the branch, warn and `return` (exit the loop).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck + Lint | `npm run check` | exit 0, 0 errors |
| Disposable unit tests | `node --test .verification/trace.test.ts` | all tests pass |

## Scope

**In scope** (the only file you should modify):
- `trace/index.ts`

**Out of scope** (do NOT touch):
- `shared/display.ts`
- `worker-board/`
- `README.md` (updated once in Plan 004)
- Nested `codemode` `details.calls` inspection (added cleanly on top in Plan 004)
- Committed test files — delete `.verification/` before finishing.

## Git workflow

- Branch: `advisor/001-004-trace-worker-board`
- Commit once all steps and checks pass (e.g. `Add tool filtering, call previews, and persistent picker to /trace`).
- Do NOT push or open a PR.

## Steps

### Step 1: Parse `/trace [failed] [tool]` arguments in `trace/index.ts`

Update command description and argument parsing in `trace/index.ts`:
- Description: `"Inspect recorded tool results on this branch: /trace [failed] [tool]"`
- Parse `const tokens = args.trim() ? args.trim().split(/\s+/u) : [];`
- Reject invalid forms: if `tokens.length > 2 || (tokens.length === 2 && tokens[0] !== "failed")`, notify `"Usage: /trace [failed] [tool]"` (`"warning"`) and `return`.
- Derive:
  - `const failedOnly = tokens[0] === "failed";`
  - `const tool = failedOnly ? tokens[1] : tokens[0];`

**Verify**: `npm run check` → exits 0.

### Step 2: Pair `toolCallId` with sanitized `toolCall` previews

1. Add a small pure helper `callPreview(args: unknown): string` in `trace/index.ts`:
   - Guard `if (typeof args !== "object" || args === null || Array.isArray(args)) return "";`
   - Cast `const rec = args as Record<string, unknown>;`
   - Check priority keys in order: `["command", "path", "file_path", "pattern", "query", "url", "action", "agent", "workflow"]` — for the first key where `typeof rec[key] === "string"`, return `displayLabel(rec[key], 40)` if non-empty.
   - If `typeof rec.code === "string"` (e.g. `codemode`), take the first non-empty line that does not start with `// @options:` (`rec.code.split(/\r?\n/u).find((l) => l.trim() && !l.trim().startsWith("// @options:")) ?? ""`) and return `displayLabel(line, 40)`.
   - Otherwise return `""`.
2. During the single forward pass over `ctx.sessionManager.getBranch()`:
   - Maintain `const calls = new Map<string, unknown>();`.
   - When `entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)`, record each `block` where `block.type === "toolCall"` into `calls.set(block.id, block.arguments)`.
   - Store `preview: string` on `TraceItem` (`preview: callPreview(calls.get(msg.toolCallId))`).
3. Render each picker label as:
   ```ts
   `${offset + i + 1}. ${msg.isError ? "failed" : "ok"} ${displayLabel(msg.toolName, 64) || "?"}${preview ? ` (${preview})` : ""} · ${displayLabel(time, 32) || "?"} · #${displayLabel(id, 36) || "?"}`
   ```

**Verify**: `npm run check` → exits 0.

### Step 3: Keep the selector loop open after showing diagnostics

In the `else` branch of `for (;;)` in `trace/index.ts`:
- Keep the branch-membership re-check (`if (!ctx.sessionManager.getBranch().some(...)) { ctx.ui.notify(..., "warning"); return; }`).
- Emit `ctx.ui.notify(`${pick}\n${diagnostic(selected.msg.content)}`, selected.msg.isError ? "warning" : "info");` and **loop back** (remove `return;` after `ctx.ui.notify`) so the picker re-opens on the current `offset` page until the user cancels (`!pick`) or `signal.aborted` fires!

**Verify**: `npm run check` → exits 0.

### Step 4: Run disposable tests in `.verification/trace.test.ts` and delete them

Create `.verification/trace.test.ts` (`trace/index.ts` has only `import type` peer imports, so `node --test .verification/trace.test.ts` runs directly in Node >= 22.19 without `node_modules`!) verifying:
- `/trace`, `/trace failed`, `/trace bash`, `/trace failed bash`, and invalid `/trace foo bar` -> usage warning.
- `callPreview` populates sanitized `command` / `path` / `codemode` first non-options line, and redacts credentials (`Bearer secret123`, `https://u:p@example.com`, `API_KEY=xyz`) via `displayLabel`.
- Persistent loop: selecting item 1 notifies diagnostics and immediately re-opens `select` on the same page (`offset` preserved on page 2!), then `undefined` (Esc) exits cleanly.
- `session_tree` abort and stale-branch guard still abort/exit immediately without leaking diagnostics.

Run `node --test .verification/trace.test.ts`, confirm 0 failures, then delete `.verification/`.

**Verify**: `rm -rf .verification && npm run check && test ! -e .verification && echo CLEAN` → `CLEAN`

## Test plan

- Disposable `.verification/trace.test.ts` covering all 4 groups in Step 4, deleted before commit.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] Disposable `.verification/trace.test.ts` ran and passed 100% of assertions before deletion
- [ ] `test ! -e .verification` exits 0
- [ ] Only `trace/index.ts` is modified in this commit (`git diff --name-only HEAD~1..HEAD`)

## STOP conditions

- `trace/index.ts` differs from "Current state".
- Any test fails twice after a minimal fix attempt.
- Changes require modifying `shared/display.ts`.

## Maintenance notes

- Plan 004 builds directly on `TraceItem` and `diagnostic` in `trace/index.ts` to surface nested `codemode` `details.calls`; keep `TraceItem` and `diagnostic` clean and concise.
