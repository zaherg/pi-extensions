"""Offline, isolated pseudo-terminal acceptance for the /git extension."""

import errno
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest
from contextlib import suppress
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = Path(os.environ["PI_PACKAGE_ROOT"])
PAUSE = b"Press Enter to return to Pi... "
ANSI = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


class GitTerminalTest(unittest.TestCase):
    def run_terminal(self, mode, width, shell="/bin/sh"):
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js is required for the terminal check")
        with tempfile.TemporaryDirectory(prefix="pi-git terminal;-") as directory:
            root = Path(directory)
            env = {
                "PATH": os.environ["PATH"],
                "HOME": directory,
                "XDG_CONFIG_HOME": str(root / "config"),
                "PI_CODING_AGENT_DIR": str(root / "agent"),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
                "TERM": "xterm-256color",
                "SHELL": shell,
                "LANG": "en_US.UTF-8",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_TERMINAL_PROMPT": "0",
            }
            (root / "agent").mkdir()
            (root / "agent" / "settings.json").write_text(
                json.dumps({"quietStartup": True})
            )
            ready = root / "ready.ts"
            ready.write_text(
                'import { writeFileSync } from "node:fs";\n'
                "export default function(pi) { let timer; "
                'pi.on("session_start", (_event, ctx) => { let seen = 0; '
                'ctx.ui.notify("GIT_TERMINAL_READY", "info"); '
                "timer = setInterval(() => { "
                "const entries = ctx.sessionManager.getEntries().filter(e => "
                'e.type === "custom" && e.customType === "git-output"); '
                "if (entries.length === seen) return; seen = entries.length; "
                'writeFileSync("inline-entries.json", JSON.stringify({ entries, '
                "messages: ctx.sessionManager.buildSessionProjection().messages })); "
                'ctx.ui.notify(`GIT_INLINE_RESULT_${seen}`, "info"); }, 50); }); '
                'pi.on("session_shutdown", () => clearInterval(timer)); }\n'
            )

            def git(*args):
                return subprocess.check_output(
                    ["git", *args],
                    cwd=root,
                    env=env,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=5,
                ).strip()

            git("init", "--quiet", "--template=")
            git("config", "user.name", "Git Terminal Test")
            git("config", "user.email", "git-terminal@example.invalid")
            git("config", "commit.gpgsign", "false")
            (root / "hooks").mkdir()
            git("config", "core.hooksPath", str(root / "hooks"))
            tracked = root / "staged file.txt"
            tracked.write_text("staged content\n")
            editor = root / "test-editor"
            editor.write_text(
                "#!/bin/sh\n[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 31\n"
                'stty size > editor-size\nprintf "GIT_EDITOR_INPUT> "\nIFS= read -r answer\n'
                '[ "$answer" = yes ] || exit 32\n'
                'printf "editor exact message\\n" > "$1"\n'
            )
            editor.chmod(0o700)
            pager = root / "test-pager"
            pager.write_text(
                '#!/bin/sh\n/bin/cat\nprintf "GIT_PAGER_INPUT> "\n'
                'IFS= read -r answer < /dev/tty\n[ "$answer" = yes ]\n'
            )
            pager.chmod(0o700)
            waiter = root / "test-wait"
            waiter.write_text(
                '#!/bin/sh\nprintf "%s" "$$" > waiter-pid\nprintf "GIT_WAITING\\n"\nexec sleep 30\n'
            )
            waiter.chmod(0o700)
            noisy = root / "test-noisy"
            noisy.write_text(
                "#!/bin/sh\nprintf x >> noisy-runs\n/usr/bin/awk 'BEGIN { for (i=0; i<2000; i++) print \"synthetic verbose output line\" }'\n"
                'printf "fatal: synthetic final diagnostic\\n" >&2\nexit "${1:-0}"\n'
            )
            noisy.chmod(0o700)
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(root)
                # Fixed executable/argv, no shell; RUF100 permits profiles without S606.
                os.execve(  # noqa: S606, RUF100
                    node,
                    [
                        node,
                        str(PACKAGE / "dist" / "cli.js"),
                        "--offline",
                        "--no-extensions",
                        "--no-mcp",
                        "--no-skills",
                        "--no-prompt-templates",
                        "--no-context-files",
                        "--no-themes",
                        "--no-session",
                        "--tui-mode",
                        mode,
                        "-e",
                        str(ROOT / "index.ts"),
                        "-e",
                        str(ready),
                    ],
                    env,
                )
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
            buffer = bytearray()
            transcript = bytearray()
            exited = False
            result_count = 0

            def receive(marker, timeout=12):
                markers = (marker,) if isinstance(marker, bytes) else marker
                deadline = time.monotonic() + timeout
                while not any(item in buffer for item in markers):
                    if time.monotonic() >= deadline:
                        tail = ANSI.sub(b"", bytes(buffer[-5000:])).decode(
                            errors="replace"
                        )
                        self.fail(f"Timed out waiting for {marker!r}: {tail!r}")
                    if not select.select([fd], [], [], 0.1)[0]:
                        continue
                    try:
                        data = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            self.fail(f"Pi exited while waiting for {marker!r}")
                        raise
                    self.assertTrue(data, "Unexpected terminal EOF")
                    buffer.extend(data)
                    transcript.extend(data)
                    self.assertLess(len(transcript), 2_000_000)
                end = min(
                    buffer.index(item) + len(item) for item in markers if item in buffer
                )
                observed = bytes(buffer[:end])
                del buffer[:end]
                return observed

            def send(text):
                os.write(fd, text.encode())

            def drain_frame():
                output = bytes(buffer)
                buffer.clear()
                deadline = time.monotonic() + 2
                while select.select([fd], [], [], 0.15)[0]:
                    self.assertLess(time.monotonic(), deadline)
                    data = os.read(fd, 65536)
                    self.assertTrue(data)
                    transcript.extend(data)
                    output += data
                return output

            def receive_result(expected, diagnostic=None):
                nonlocal result_count
                result_count += 1
                output = receive(f"GIT_INLINE_RESULT_{result_count}".encode())
                snapshot = json.loads((root / "inline-entries.json").read_text())
                self.assertEqual(len(snapshot["entries"]), result_count)
                self.assertEqual(
                    snapshot["messages"], [], "Git output entered model context"
                )
                message = snapshot["entries"][-1]["data"].encode()
                headings = (expected,) if isinstance(expected, bytes) else expected
                self.assertTrue(
                    any(message.startswith(heading) for heading in headings)
                )
                if diagnostic is not None:
                    self.assertIn(diagnostic, message)
                self.assertFalse(termios.tcgetattr(fd)[3] & termios.ICANON)
                # Full redraws repeat older entries; finish the frame before typing again.
                return ANSI.sub(b"", output + drain_frame())

            def finish_command(diagnostic=None):
                output = receive_result(b"Git shell completed.", diagnostic)
                self.assertNotIn(
                    PAUSE, output, "Successful commands must return automatically"
                )
                return output

            def finish_failure(expected, diagnostic=None):
                output = receive_result(expected, diagnostic)
                self.assertNotIn(
                    PAUSE, output, "Failed commands must return automatically"
                )
                return output

            try:
                receive(b"GIT_TERMINAL_READY")
                # Let the custom notification and initial terminal queries finish rendering.
                time.sleep(0.3)
                send('/git add "staged file.txt"\r')
                finish_command(b"(No output)")
                tracked.write_text("unstaged content\n")
                (root / "untracked.txt").write_text("leave alone\n")
                send('/git commit "terminal exact message"\r')
                output = finish_command(b"terminal exact message")
                self.assertIn(b"terminal exact message", output)
                self.assertEqual(
                    git("log", "-1", "--format=%B"), "terminal exact message"
                )
                self.assertEqual(git("show", "HEAD:staged file.txt"), "staged content")
                self.assertEqual(tracked.read_text(), "unstaged content\n")
                self.assertNotIn("untracked.txt", git("ls-tree", "--name-only", "HEAD"))

                send("/git add -p\r")
                receive(b"Stage this hunk")
                send("n\r")
                finish_command()
                self.assertEqual(git("diff", "--cached", "--name-only"), "")

                send("/git -c core.editor=./test-editor commit --allow-empty\r")
                receive(b"GIT_EDITOR_INPUT> ")
                send("yes\r")
                finish_command()
                self.assertEqual(
                    git("log", "-1", "--format=%B"), "editor exact message"
                )
                self.assertEqual(
                    (root / "editor-size").read_text().strip(), f"30 {width}"
                )

                send("/git -c core.pager=./test-pager log -1\r")
                receive(b"GIT_PAGER_INPUT> ")
                send("yes\r")
                finish_command()

                send('/git -c alias.native="status --short" native | head -1\r')
                finish_command()
                send("/git not-a-real-git-command\r")
                output = finish_failure(b"Git command failed (exit 1).", b"not a git")
                self.assertIn(b"not a git command", output)
                send("/git rev-parse --verify refs/heads/missing-for-test\r")
                finish_failure(
                    b"Git command failed (exit 128).",
                    b"fatal: Needed a single revision",
                )
                send("/git --version\r")
                self.assertIn(b"git version", finish_command(b"git version"))

                send('/git -c alias.noisy="!./test-noisy" noisy 0\r')
                self.assertGreater(
                    len(finish_command(b"[Last output only]")), 16 * 1024
                )
                send('/git -c alias.noisy="!./test-noisy" noisy 128\r')
                finish_failure(
                    b"Git command failed (exit 128).",
                    b"fatal: synthetic final diagnostic",
                )
                self.assertEqual(
                    (root / "noisy-runs").read_text(),
                    "xx",
                    "Failed commands must not be rerun for capture",
                )
                self.assertFalse((root / "typescript").exists())
                send(
                    "/git -c alias.two='!printf \"fatal: synthetic exit two\\n\" >&2; exit 2' two\r"
                )
                finish_failure(
                    b"Git command failed (exit 2).", b"fatal: synthetic exit two"
                )

                send('/git -c alias.wait="!./test-wait" wait\r')
                receive(b"GIT_WAITING\r\n")
                # script relays the outer raw terminal into Git's own pseudoterminal.
                self.assertFalse(termios.tcgetattr(fd)[3] & termios.ICANON)
                send("\x03")
                # Depending on shell exec optimization, SIGINT is a signal or exit 130.
                finish_failure(
                    (
                        b"Git shell stopped by SIGINT.",
                        b"Git command failed (exit 130).",
                    )
                )
                send("/git --version\r")
                output = finish_command(b"git version")
                rendered = re.search(
                    rb"Git shell completed\.\s+git version[^\r\n]+", output
                )
                self.assertIsNotNone(
                    rendered, "Result was not rendered in the restored Pi interface"
                )
                if rendered is not None:
                    print(
                        f"{mode} {width} columns, rendered result: {b' '.join(rendered.group().split())!r}"
                    )
                waiter_pid = int((root / "waiter-pid").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(waiter_pid, 0)

                snapshot = json.loads((root / "inline-entries.json").read_text())
                self.assertTrue(
                    all(len(entry["data"]) < 4200 for entry in snapshot["entries"])
                )
                send("/reload\r")
                # Reload's own notice may replace the startup notice before rendering.
                restored = receive(f"GIT_INLINE_RESULT_{result_count}".encode())
                restored += drain_frame()
                self.assertEqual(
                    json.loads((root / "inline-entries.json").read_text()), snapshot
                )
                self.assertRegex(
                    ANSI.sub(b"", restored), rb"Git shell completed\.\s+git version"
                )
                send("/git --version\r")
                finish_command(b"git version")
                self.assertNotIn(PAUSE, transcript)
                send("\x04")
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    waited, status = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        exited = True
                        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                        break
                    if select.select([fd], [], [], 0.05)[0]:
                        try:
                            os.read(fd, 65536)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                self.assertTrue(exited, "Pi did not exit normally")
                visible = ANSI.sub(b"", bytes(transcript))
                self.assertNotIn(b"Git terminal execution failed", visible)
                self.assertNotIn(b"Error: Git shell exited", visible)
                print(
                    f"{mode} {width} columns: inline results, reload, no Enter prompt, no model context, staged-only commit, add -p, editor, pager, alias/pipe, failure, Ctrl+C passed"
                )
            except BaseException:
                print(
                    "Synthetic terminal tail:",
                    repr(
                        ANSI.sub(b"", bytes(transcript[-1500:])).decode(
                            errors="replace"
                        )
                    ),
                    flush=True,
                )
                raise
            finally:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    # Fall back to the owned PID when group signalling is refused.
                    with suppress(ProcessLookupError):
                        os.kill(pid, signal.SIGKILL)
                os.close(fd)
                if not exited:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                        time.sleep(0.05)
                    else:
                        raise RuntimeError(f"Could not reap test Pi process {pid}")

    def test_fullscreen(self):
        self.run_terminal("fullscreen", 100, os.environ.get("SHELL") or "/bin/sh")

    def test_regular_narrow(self):
        self.run_terminal("regular", 45)


if __name__ == "__main__":
    unittest.main()
