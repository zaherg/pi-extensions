# /git

Run any installed Git command or Git alias directly in the current Pi project, without a model call.
Load the extension with `/reload` or restart Pi.

```text
/git status
/git add src/example.ts
/git commit "Fix validation"
/git commit -m "Fix validation" --amend
/git diff --cached
/git log --oneline -10
/git push
/git add -p
/git rebase -i HEAD~3
/git -C ../another-project status
```

Only a standalone `commit "message"` or `commit 'message'` is rewritten to `git commit -m ...`.
It commits staged files without staging anything automatically.
Use native Git syntax for flags, global options, shell pipelines, or explicit pathspecs, such as `/git commit -- path.txt`.
An empty `/git` displays Git's usage.

The extension suspends Pi's interface and runs the command through `$SHELL`, falling back to `/bin/sh`.
Git keeps terminal access for editors, pagers, credentials, and interactive commands.
Commands return automatically and show their result inline in Pi's conversation, without an Enter prompt.
Successful commands include their output; failed commands include Git's diagnostic text and exit status.
Successful commands with no captured output show `(No output)`.
Ctrl+C interrupts the foreground command without closing Pi.
Run `/git` while the agent is idle.
Interactive Pi, `/bin/bash`, `/bin/sh`, and the system `script`, `tee`, and `tail` utilities are required.
The capture wrapper has macOS and Linux command variants; RPC and print modes are refused.

## Shell behavior

The supplied text is shell code, not a restricted Git API.
Quotes, expansions, pipes, redirects, and chained commands behave as they do in that shell.
Only run trusted input; destructive commands, Git hooks, and shell commands execute without an additional confirmation.
The shell inherits the environment but does not explicitly load interactive shell startup files.
Configured Git aliases work normally; interactive shell aliases depend on shell startup behavior.

Output remains visible live through a pseudoterminal, preserving terminal access on stdin, stdout, and stderr.
A bounded 16 KiB output tail is captured in memory; no separate raw transcript file is created.
After execution, Pi displays the last 20 lines or 4,000 characters of that tail, with terminal controls removed and common credential patterns redacted.
`[Last output only]` marks truncated output; the command's live terminal output is not truncated.
This redaction is defense in depth, not a detector for arbitrary secrets printed by hooks or aliases.
If no usable diagnostic was captured, the message says so rather than inventing a cause.
Commands are never rerun to obtain output.

Only the sanitized display text is added to a custom session entry, which appears inline and survives session reloads.
It is not added to model context and does not trigger a model call.
Raw captured bytes and command arguments are not stored by this extension.
Normal terminal scrollback and Pi input history can still retain what was typed or displayed.
Inline rendering requires Pi's `registerEntryRenderer` API, verified with Pi 1.5.1.
Each invocation has a temporary terminal, not a persistent background shell.
For a pipeline or command chain, the reported status is the user shell's final status unless the capture utilities fail.
Interruption does not roll back changes already made by Git.

## Checks

```sh
# From the repository root:
PI_PACKAGE_ROOT=/path/to/@earendil-works/pi-coding-agent node --test git/tests/git.test.mjs
PI_PACKAGE_ROOT=/path/to/@earendil-works/pi-coding-agent python3 git/tests/git-terminal.py
```

Tests use disposable repositories and isolated Git configuration.
The terminal check launches an offline Pi in a pseudo-terminal with this extension and a synthetic readiness marker.
It covers fullscreen and narrow regular layouts, interactive staging, terminal descriptors and dimensions, editors, pagers, Ctrl+C, terminal restoration, and inline results after `/reload`.
Success and failure checks require inline results without an Enter prompt, verify exit codes 2 and 128, and run another command afterward.
Custom entries are checked against Pi's model-context projection to confirm that output stays display-only.
Verbose success and failure checks exercise bounded capture without rerunning or truncating the command's live output.
Remote authentication, push/pull, physical keyboard input, Linux, and Windows have not been tested.
