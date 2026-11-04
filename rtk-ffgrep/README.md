# RTK filtering for `ffgrep`

This local Pi extension forwards successful, single-text-block `ffgrep` results to RTK's native post-tool pipeline.
It leaves the stock `extensions/rtk.ts` bash hook unchanged.

## Configuration

The pipeline is stored at `~/.config/rtk/pipeline.toml`.
The adapter sets `RTK_CONFIG_DIR` to that directory for its child processes, without changing the session environment or requiring a symlink.
RTK also loads `~/.config/rtk/pipelines/*.toml` and trusted project `.rtk` pipelines according to its normal precedence.
The override affects pipeline loading only.
On macOS, native `config.toml`, tracking, and recall remain under `~/Library/Application Support/rtk/`.

```toml
schema_version = 1

[pipeline]
name = "pi-ffgrep"
extends = "rtk:default"

[[hook.after_tool.any]]
name = "ffgrep-output"
use = ["ansi", "cap"]
```

RTK 1.1 classifies `ffgrep` as `any` and currently supplies `tool = "any"` to post-tool rules, despite the documentation describing raw names under `any`.
A `when = { tool = "ffgrep" }` condition therefore does not match.
The adapter restricts submission to `ffgrep`; it does not forward other Pi tools.
Other clients explicitly using this pipeline can match its `any` rule too.

The default methods strip terminal escapes and cap outputs exceeding 300 lines to the first 50 and last 200 lines, with an omission marker and a native recall command.
RTK's `cap` also limits individual lines to 2,000 characters; FFF already normally caps them at 500.
FFF already groups and trims its results, so short outputs usually pass through unchanged.
The `matches` method is not appropriate for FFF's grouped headings and numbered context lines.

Validate or inspect the pipeline explicitly:

```bash
RTK_CONFIG_DIR="$HOME/.config/rtk" rtk pipeline validate
RTK_CONFIG_DIR="$HOME/.config/rtk" rtk pipeline explain --agent pi --tool ffgrep
```

Set `enabled = false` on the `ffgrep-output` rule to disable it.
Setting `RTK_DISABLED=1` in the Pi process environment also bypasses the adapter.
Pipeline changes take effect on subsequent tool calls; extension changes require `/reload` or a Pi restart.

## Safety and compatibility

The adapter uses `rtk hook claude` as a JSON-stdin compatibility transport, with the real `tool_name: "ffgrep"`.
It does not launch Claude, impersonate `Grep`, execute a shell, or send a transcript to RTK.
Filtering with the supplied pipeline is local and makes no model requests.
Native tracking retains the `ffgrep` identity; tool execution duration is not supplied.

The filtered text reaches the model, appears in Pi's tool output, and is saved in session messages.
Pi details, block metadata, usage, and error state are preserved.
Errors, images, multiple blocks, and structured results pass through untouched.
All original file headings, annotations, warning lines, and pagination notices must remain in order.
Numbered-looking filenames at group boundaries are ambiguous in FFF's text format, so those results remain unfiltered.
A replacement must be smaller and carry a supported native hash-based recall hint.
The adapter reads that hash back with `rtk recall --full`, rejects malformed UTF-8, preserves any byte-order mark, and verifies the original text exactly before accepting the replacement.
Disabled, failed, expired, or legacy file-based recovery therefore leaves the original output intact.

Each RTK process has a two-second timeout and a two-MiB combined output limit.
The stdin payload is also limited to two MiB.
Cancellation and session shutdown terminate active child process groups on macOS/Linux.
Failures retain the original result and report a content-free warning once per failure category per session.
RTK may already have recorded a filtering attempt before an adapter guard rejects it, so `rtk gain` can overstate accepted savings for rejected results.

Verified against RTK 1.1.0 and Pi 1.5.0.
The native posthook protocol, recall-hint syntax, and unknown-tool facts are compatibility boundaries; unsupported changes preserve the original result rather than guessing.
No RTK binary or installed FFF package is patched.

## Checks

```bash
PI_PACKAGE_ROOT="$HOME/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent" \
  node --test tests/rtk-ffgrep*.test.mjs
```

Run from `~/.pi/agent` and update `PI_PACKAGE_ROOT` after Pi upgrades.
Tests use temporary homes, synthetic search data, native RTK, and Pi's extension loader.
No model provider is called and no real search output is stored by the tests.

Local verification passed 20 tests, strict TypeScript, Biome, LSP diagnostics, and native pipeline validation.
The integration test executes the installed FFF tool through Pi's result middleware, follows a retained pagination cursor, and checks byte-exact native recall.
Independent source review closed the heading and UTF-8 findings; its final warning-wording note was corrected and retested.
Interactive activation, the minimum supported Node version, and Linux/Windows operation have not been verified.
