# RTK for other Pi tools

This local Pi extension reduces tool output that RTK's stock Pi hook never sees.
It filters raw Bash output through RTK's native post-tool pipeline, deduplicates repeated `read` results and numbered fenced code excerpts, condenses non-code file views, and applies lossless rewrites and passage deduplication across Bash, search, and MCP results.
It also adds `/rtk-coverage`, a Pi-specific report of delivered tool output, coverage, and savings.
It complements the stock `extensions/rtk.ts` Bash hook and does not change it.
It replaces the former `rtk-ffgrep` extension; remove any separately installed copy of it.

## Coverage

| Results                                                                                                 | Category   | Handling                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read` (including 2-block `pi-lens` widened reads)                                                      | `read`     | Repeat reads become stubs; lockfiles, minified files, large truncated JSON, and logs get labelled views; code and prose stay exact                                                                            |
| Successful `bash` commands that only print one file (`cat`, `sed -n`, `head`, `tail`, `nl`, `rtk read`) | `read`     | Same non-code views as `read`; code and prose stay exact                                                                                                                                                      |
| Other `bash` commands, including failed ones                                                            | `terminal` | RTK `term` chain, then lossless JSON compaction, grep grouping (`rg` and diagnostics), shared-tail footnotes, and passage deduplication                                                                       |
| `bash` commands where every segment runs an `rtk` filter                                                | `terminal` | RTK `term` chain only when output still has terminal escapes, carriage returns, or exceeds RTK's `cap` limits (`> 300` lines or `> 2,000`-char lines); lossless rewrites and passage deduplication still run  |
| `grep`, `find`, `ls`, FFF's `ffgrep`, `fffind`, `fff-multi-grep`, and FFF's override names              | `listing`  | RTK window that keeps FFF headings and cursors, then lossless grouping for Pi `grep`                                                                                                                          |
| MCP and other extension tools                                                                           | `generic`  | RTK escapes, base64, and repeated lines, then numbered fenced excerpt deduplication against visible `read` results, lossless JSON compaction, grep grouping, shared-tail footnotes, and passage deduplication |
| `edit`, `write`, `rtk recall` output                                                                    | none       | Never changed                                                                                                                                                                                                 |

Results smaller than 512 bytes, results containing image blocks, `read` results with unrecognized multi-block layouts, and calls issued by another tool, such as a codemode script, pass through untouched.
Non-`bash` error results also pass through untouched.

The stock hook mutates the command before execution, and `tool_result` receives that mutated input.
A compound command is treated as already wrapped only when every non-setup command segment runs an `rtk` subcommand other than `rtk read`.
Even on wrapped commands, terminal escapes, carriage returns, or outputs over 300 lines or 2,000 characters per line indicate RTK passed raw output through (for example `rtk rg -n -C 2`), so RTK's `term` chain still runs.

## Reads

### Deduplication

A `read` whose lines are identical to an earlier `read` result of the same file becomes a stub naming that tool call.
When `pi-lens` widens a `read` and prepends its `[pi-lens: read widened ...]` banner block, the banner stays untouched in `content[0]` and deduplication operates on the file body in `content[1]`.
When only part of the range was read before, the shared lines become one marker line and every other line stays verbatim.
Comparison uses the actual text of both results, so a file changed by `edit`, `write`, Bash, or another program never matches stale lines.
A stub only points at a result that is still in the model-visible session projection, so compaction, branch changes, and pruned results end deduplication automatically.
Successful `edit` and `write` results, `session_compact`, `session_tree`, `session_start`, and shutdown also clear the index.

### Non-code views

Only these file classes are ever condensed, and only when the view saves at least 128 bytes and 10%:

| Class    | Files                                                                                                                                                                    | View                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Lockfile | `bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `go.sum` | Unique `name@version` entries, when at least three are found             |
| Minified | `*.min.js`, `*.min.mjs`, `*.min.cjs`, `*.min.css`, `*.js.map`, `*.css.map`                                                                                               | Lines over 300 characters trimmed, each with a `…[+N chars]` marker      |
| JSON     | `*.json` of at least 16 KB                                                                                                                                               | Leading indentation removed; for `read`, only when Pi truncated the file |
| Log      | `*.log`, `*.log.N`                                                                                                                                                       | RTK `term` chain, with RTK recall                                        |

Every condensed view starts with an `[rtk-pi-extended]` header that says it is not the file's literal text, must not be copied into `edit`, and how to get the exact text.
Pi's continuation notice, and a Bash view's truncation notice, stay verbatim at the end.

### Exact text on request

Reading the same path and offset again after a stub or condensed view returns the exact text.
After a condensed Bash view of a file, a `read` of any range of that file returns the exact text.
Recovery is the file itself, so no copy of file contents is stored outside Pi's session.

### Edit safety

Code, Markdown, and every other file outside the classes above are never transformed.
Stubs and markers are labelled and never replace a line with different text.
Pi's exact-match `edit` fails on any header or marker line copied into `oldText`, rather than matching the wrong text.

## Lossless rewrites and context deduplication

Each lossless rewrite rebuilds its input exactly from its output before it is used, and is skipped unless it makes the text smaller.

- **Grep grouping:** `rg -n`, `rtk rg -n -C`, compiler diagnostics, and Pi `grep` lines (`path:12:text`, `path:12: text`, `path-13-context`, and `--` hunk separators) are grouped under one heading per consecutive run of a file, with line numbers kept.
  Plain `grep`/`egrep`/`fgrep` Bash commands stay ungrouped so `pi-lens` can credit search-reads when loaded after this extension.
- **JSON compaction:** a complete, valid, indented JSON document loses its indentation, keeping any trailing Pi truncation or exit-code notice intact.
- **Shared tails:** a tail of at least 40 characters shared by three or more non-fenced lines becomes a Markdown footnote marker, defined once at the end.
  Lines inside fenced code blocks are never rewritten with footnote markers.
- **Read-excerpt deduplication:** numbered `<line>\t<code>` hunks inside fenced blocks under a ``**`path`**`` heading (such as `codegraph_explore` output) become pointers when every line matches an earlier model-visible `read` of that file.
- **Passages:** a blank-line-separated passage of at least 256 bytes that the same tool already returned, in a result the model can still see, becomes a pointer to that tool call while keeping surrounding Markdown code fences balanced.
  The final passage and trailing notices are always kept, so status lines survive.

## Pipelines

Each RTK profile has its own pipeline directory under `rtk/`:

| Profile    | Methods                         | Effect                                                                                                                                                                                                                          |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal` | `term`                          | Removes terminal escapes and progress frames, collapses three or more identical adjacent lines, elides long base64 runs, keeps the first 50 and last 200 lines of outputs over 300 lines, and cuts lines over 2,000 characters. |
| `listing`  | `ansi`, `cap`                   | Removes terminal escapes, keeps the first 50 and last 200 lines of outputs over 300 lines, and cuts lines over 2,000 characters.                                                                                                |
| `generic`  | `ansi`, `base64-elide`, `dedup` | Removes terminal escapes, elides long base64 runs, and collapses repeated adjacent lines without truncating text.                                                                                                               |

`term` is the chain RTK's `rtk:posthook` pipeline applies to non-RTK shell output in Claude Code.
The `generic` profile does not truncate because MCP output is usually curated and Pi already middle-truncates MCP results at 20 KB.
Append `"cap"` to its `use` list to window long MCP output as well.

Before starting RTK, the extension checks whether any method of the profile's rule could change the text, such as escapes for `ansi` or more than 300 lines for `cap`.
If none could, RTK is not started.
Each RTK child process runs with both `RTK_CONFIG_DIR` and `cwd` set to the selected profile directory so project `.rtk/` files in the workspace cannot override the bundled rule.
The `pi-` prefix keeps RTK from treating `bash` or `mcp__*` names as Claude Code tools, and gives these calls distinct `rtk gain` rows.

Validate or inspect a profile:

```sh
# Run from the extension directory (rtk-pi-extended/).
RTK_CONFIG_DIR="$PWD/rtk/terminal" rtk pipeline validate
RTK_CONFIG_DIR="$PWD/rtk/terminal" rtk pipeline explain --agent claude-code --tool pi-bash
```

Set `enabled = false` on a profile's rule to disable it.
`RTK_DISABLED=1` in Pi's environment bypasses the extension entirely.
Pipeline edits apply to subsequent calls; extension source changes require `/reload` or a restart.

## RTK configuration

The stock hook rewrites `cat`, `head`, and `tail` of a file to `rtk read`, which prints the file unchanged, and `bun run`, `bun test`, and `bunx` to RTK wrappers that can pass output through.
This extension treats `rtk read` like `cat`, so excluding these commands from rewriting changes no file view.
Excluding them saves the extra `rtk` process per command and lets this extension filter `bun` output that has no terminal escapes.
The `rtk rewrite` call the stock hook makes for every Bash command still happens.

```toml
# macOS: ~/Library/Application Support/rtk/config.toml
# Linux: ~/.config/rtk/config.toml
[hooks]
exclude_commands = ["cat", "bun run", "bun test", "bunx"]
```

Patterns match command prefixes.
This is a recommendation; the extension does not change RTK's configuration.

## Safety

The RTK transport, response validation, and recall verification live in `filterPosthook` in `bridge.ts`.
Data reaches RTK only through stdin, never through a shell or the argument list.
RTK runs before any lossless rewrite, so its recall stores the true original.
The adapter accepts an RTK replacement only if it is smaller and passes two checks:

- **Structure:** the final visible line must survive (ignoring trailing escape-only or reset lines), allowing only RTK's own rewrites of it: removed terminal escapes and progress frames, a `[xN]` repeat count after it, raw or data-URL base64 runs replaced by `[base64 <type>, <size> elided]`, and a long line cut to a prefix with a `[+N chars]` count.
  Every Pi `[... Full output: path]` notice must survive unchanged.
  In the `listing` profile, output with FFF-style numbered match lines (a space, the line number, then a colon or hyphen) must also keep every file heading and notice in order.
- **Recovery:** the output must end with a native RTK recall hint.
  The first filtered result of each session is read back with `rtk recall --full` and must match the original exactly.
  RTK only appends a hint after its store saved the original, so later results skip the readback unless the original itself contains the hash or ends like a hint.

Recovery depends on RTK's default `sqlite` recall mode; note that RTK retains only the 20 most recent `posthook` recall entries globally across sessions (`POSTHOOK_MAX_FILES = 20`).
A failed check, a missing `rtk` binary, a timeout, or an unsupported response leaves the original result in place.
Each failure category is reported once per session without exposing tool output.
Each RTK process has a two-second timeout and a two-MiB input and output limit, and is killed with its process group on cancellation or shutdown.

Lossless rewrites, deduplication stubs, and RTK cleanups must save at least 128 bytes; lossy non-code file summaries must save at least 128 bytes and 10% of the original.
An accepted replacement changes only the model-facing text (`content`), leaving Pi's details, usage, error state, and `structuredContent` unchanged.

## Coverage report

```text
/rtk-coverage [days 1-365] [project|all]
```

The default reports the last 30 days of the current project's sessions, including subagent sessions stored below them; `all` reads every project directory under the sessions root.
The report lists:

- Tool output: original bytes (delivered plus accepted savings), the share this extension touched, and the share it removed, in total and per tool, with the integration that owns each tool.
- Savings by mechanism, such as `read-dedup`, `excerpt-dedup`, `lockfile-summary`, `rtk:terminal`, `grep-group`, or `passage-dedup`.
- Bash coverage: delivered Bash output split by whether today's `rtk rewrite` rules rewrite the command the model issued, plus the largest uncovered programs.
  Leading setup commands such as `cd`, `set`, and `export` are skipped when naming a program.
- Extension outcomes: filtered, unchanged, and failed counts, with original and delivered bytes.

Only accepted replacements count as savings; unchanged and failed attempts never do.
Outcomes are recorded as `rtk-pi-extended` custom session entries at each turn end; they never reach the model.
Entries hold tool names, categories, mechanisms, outcome counts, and byte totals only, and are validated strictly when read.
The report reads only the sizes of tool results, never their text, and classifies at most the 2,000 largest distinct Bash commands with `rtk rewrite`.
It does not execute those commands.

These numbers differ from `rtk gain`, which counts every hook submission, including rejected ones.
The adapter's own `rtk recall` readback also counts as a recall in `rtk gain --recalls`.

## Limits

- Results changed by another extension's `context` handler are not visible to deduplication checks; a stub can then point at text that was pruned from the request.
  Reading the same path and offset again returns the exact text.
- `ffgrep` output is only windowed past 300 lines; FFF already groups matches, limits matches per page and line length, and paginates with a cursor.
  Its `rtk gain` rows are named `pi-ffgrep` instead of `ffgrep`.
- RTK evicts `posthook` recall entries beyond the 20 most recent lossy RTK hook outputs across concurrent sessions.
