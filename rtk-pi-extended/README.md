# RTK for other Pi tools

This local Pi extension reduces tool output that RTK's stock Pi hook never sees.
It filters raw Bash output through RTK's native post-tool pipeline, deduplicates repeated `read` results, condenses non-code file views, and applies lossless rewrites to search and MCP results.
It also adds `/rtk-coverage`, a Pi-specific report of delivered tool output, coverage, and savings.
It complements the stock `extensions/rtk.ts` Bash hook and does not change it.
It replaces the former `rtk-ffgrep` extension; remove any separately installed copy of it.

## Coverage

| Results                                                                                                 | Category   | Handling                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `read`                                                                                                  | `read`     | Repeat reads become stubs; lockfiles, minified files, large truncated JSON, and logs get labelled views; code and prose stay exact |
| Successful `bash` commands that only print one file (`cat`, `sed -n`, `head`, `tail`, `nl`, `rtk read`) | `read`     | Same non-code views as `read`; code and prose stay exact                                                                           |
| Other `bash` commands, including failed ones                                                            | `terminal` | RTK `term` chain                                                                                                                   |
| `bash` commands that run through `rtk`                                                                  | `terminal` | RTK `term` chain only when the output still has terminal escapes or carriage returns                                               |
| `grep`, `find`, `ls`, FFF's `ffgrep`, `fffind`, `fff-multi-grep`, and FFF's override names              | `listing`  | RTK window that keeps FFF headings and cursors, then lossless grouping for Pi `grep`                                               |
| MCP and other extension tools                                                                           | `generic`  | RTK escapes, base64, and repeated lines, then lossless JSON compaction, shared-tail footnotes, and passage deduplication           |
| `edit`, `write`, `rtk recall` output                                                                    | none       | Never changed                                                                                                                      |

Results smaller than 512 bytes, images, results with several content blocks, and calls issued by another tool, such as a codemode script, pass through untouched.
Non-`bash` error results also pass through untouched.

The stock hook mutates the command before execution, and `tool_result` receives that mutated input.
RTK's own filters strip terminal escapes, so escapes or carriage returns in the output of an `rtk` command mean RTK passed it through unfiltered.
Any other `rtk` output is left alone to avoid filtering it twice.

## Reads

### Deduplication

A `read` whose lines are identical to an earlier `read` result of the same file becomes a stub naming that tool call.
When only part of the range was read before, the shared lines become one marker line and every other line stays verbatim.
Comparison uses the actual text of both results, so a file changed by `edit`, `write`, Bash, or another program never matches stale lines.
A stub only points at a result that is still in the model-visible session projection, so compaction, branch changes, and pruned results end deduplication automatically.
Successful `edit` and `write` results, `session_compact`, `session_tree`, and shutdown also clear the index.

### Non-code views

Only these file classes are ever condensed, and only when the view saves enough:

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

## Lossless rewrites

Each rewrite rebuilds its input exactly from its output before it is used, and is skipped unless it makes the text smaller.

- **Grep grouping:** Pi `grep` lines (`path:12: text`, `path-13- context`) are grouped under one heading per consecutive run of a file, as FFF prints them, with line numbers kept.
  Output that already has FFF-style numbered lines is never regrouped.
- **JSON compaction:** a complete, valid, indented JSON document loses its indentation.
- **Shared tails:** a tail of at least 40 characters shared by three or more lines becomes a Markdown footnote marker, defined once at the end.
- **Passages:** a blank-line-separated passage of at least 256 bytes that the same tool already returned, in a result the model can still see, becomes a pointer to that tool call.
  The final passage is always kept, so status lines and notices survive.

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
Rule shapes the check does not model, such as extra rules or a `pipelines/` directory, always start RTK.

RTK 1.x classifies the adapter's `pi-<tool>` names as `any`, and `when.tool` conditions never match them.
The adapter therefore selects a profile by pointing `RTK_CONFIG_DIR` at that profile's directory for its child processes.
`RTK_CONFIG_DIR` only relocates pipeline files; RTK still reads `config.toml` from its platform directory.
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

- **Structure:** the final line must survive, allowing only RTK's own rewrites of it: removed terminal escapes and progress frames, a `[xN]` repeat count after it, base64 runs replaced by `[base64 data, <size> elided]`, and a long line cut to a prefix with a `[+N chars]` count.
  Every Pi `[... Full output: path]` notice must survive unchanged.
  In the `listing` profile, output with FFF-style numbered match lines (a space, the line number, then a colon or hyphen) must also keep every file heading and notice in order.
- **Recovery:** the output must end with a native RTK recall hint.
  The first filtered result of each session is read back with `rtk recall --full` and must match the original exactly.
  RTK only appends a hint after its store saved the original, so later results skip the readback unless the original itself ends like a hint.

Recovery depends on RTK's default `sqlite` recall mode; with `tee` or disabled recall, RTK output stays unfiltered and the recovery failure is reported once.
A failed check, a missing `rtk` binary, a timeout, or an unsupported response leaves the original result in place.
Each failure category is reported once per session without exposing tool output.
Each RTK process has a two-second timeout and a two-MiB input and output limit, and is killed with its process group on cancellation or shutdown.

Every replacement, from RTK or from this extension, must save at least 128 bytes and 10% of the original; otherwise the original is kept.
An accepted replacement changes only the result text, which Pi shows, sends to the model, and saves in the session.
Pi's details, usage, and error state stay unchanged, and `structuredContent` keeps the complete machine-readable result.

## Coverage report

```text
/rtk-coverage [days 1-365] [project|all]
```

The default reports the last 30 days of the current project's sessions, including subagent sessions stored below them; `all` reads every project directory under the sessions root.
The report lists:

- Tool output: original bytes (delivered plus accepted savings), the share this extension touched, and the share it removed, in total and per tool, with the integration that owns each tool.
- Savings by mechanism, such as `read-dedup`, `lockfile-summary`, `rtk:terminal`, or `grep-group`.
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
- A `read` widened by pi-lens carries a second text block when pi-lens handles it first, and is then left unchanged.
- `ffgrep` output is only windowed past 300 lines; FFF already groups matches, limits matches per page and line length, and paginates with a cursor.
  Its `rtk gain` rows are now named `pi-ffgrep` instead of `ffgrep`.
- MCP output formats other than JSON documents, repeated tails, and repeated passages get only RTK's `generic` profile.
- Passage deduplication is not applied to Bash output.

## Checks

```sh
# Run from the extension directory (rtk-pi-extended/).
npm test
PI_PACKAGE_ROOT="/path/to/node_modules/@earendil-works/pi-coding-agent" npm test
```

Tests use temporary homes, synthetic output, the native `rtk` binary, and no model provider.
With `PI_PACKAGE_ROOT` set, a further test runs Pi's real extension loader and agent loop with the stock RTK hook and a scripted model; otherwise it is reported as skipped.
Set `RTK_PI_HOOK` if the stock hook is not at `~/.pi/agent/extensions/rtk.ts`.

Verified against RTK 1.2.0 and Pi 1.5.2 on Linux and macOS.
Lockfile parsers are tested against synthetic excerpts of each format.
Windows operation and interactive use of `/rtk-coverage` have not been verified.
