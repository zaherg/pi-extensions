import { displayTail } from "../shared/display.ts";

export const CAPTURE_BYTES = 16 * 1024;

export function terminalCaptureArgs(
	shell: string,
	command: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	// Run Git under script with live terminal output and bounded tail capture.
	const invocation =
		platform === "darwin"
			? `/usr/bin/script -q /dev/null /bin/bash -c 'trap : INT; "$1" -c "$2"; exit $?' pi-git "$1" "$2"`
			: platform === "linux"
				? 'SHELL="$1" /usr/bin/script -q -e -c "$2" /dev/null'
				: undefined;
	if (!invocation)
		throw new Error("Git terminal capture requires macOS or Linux.");
	return [
		"-c",
		`set -o pipefail
for tool in /usr/bin/script /usr/bin/tee /usr/bin/tail; do
  if [ ! -x "$tool" ]; then
    printf 'Git terminal capture requires %s.\\n' "$tool"
    exit 127
  fi
done
${invocation} 2>&1 | { /usr/bin/tee /dev/tty 2>/dev/null || true; } | /usr/bin/tail -c "$3"`,
		"pi-git",
		shell,
		command,
		String(CAPTURE_BYTES + 1),
	];
}

export function gitResultMessage(
	output: Buffer | null | undefined,
	status: number | null,
	signal: NodeJS.Signals | null = null,
): string {
	const heading = signal
		? `Git shell stopped by ${signal}. Check git status before retrying.`
		: status === 0
			? "Git shell completed."
			: `Git command failed (exit ${status ?? "unknown"}).`;
	const empty =
		status === 0 && !signal
			? "(No output)"
			: "No diagnostic text was captured; check the terminal output.";
	const cut = (output?.length ?? 0) > CAPTURE_BYTES;
	const sliced =
		cut && output ? output.subarray(output.length - CAPTURE_BYTES) : output;
	return `${heading}\n${displayTail(sliced?.toString("utf8") ?? "", cut, empty)}`;
}
