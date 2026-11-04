import { stripVTControlCharacters } from "node:util";

export const CAPTURE_BYTES = 16 * 1024;
const DISPLAY_CHARACTERS = 4000;
const DISPLAY_LINES = 20;

export function terminalCaptureArgs(
	shell: string,
	command: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	// script gives Git a real terminal on all three descriptors. tee preserves
	// live output; tail bounds capture without stopping a verbose Git command.
	// macOS script reports a signal number as its exit code. A waiting shell
	// normalizes SIGINT to 130 while preserving ordinary exit codes, including 2.
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
${invocation} 2>&1 | /usr/bin/tee /dev/tty | /usr/bin/tail -c "$3"`,
		"pi-git",
		shell,
		command,
		String(CAPTURE_BYTES),
	];
}

export function gitFailureMessage(
	output: Buffer | null | undefined,
	status: number | null,
): string {
	let text = output?.toString("utf8") ?? "";
	const captureTruncated = (output?.length ?? 0) >= CAPTURE_BYTES;
	if (captureTruncated) {
		// A partial first line can lack the prefix identifying a credential.
		const newline = text.indexOf("\n");
		text = newline < 0 ? "" : text.slice(newline + 1);
	}
	text = stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
			character === "\n" || character === "\t" ? character : "",
		);

	// Defense in depth for common credentials, not an arbitrary-secret detector.
	// This text stays in Pi's transient UI, never in a model message or session entry.
	text = text
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(
			/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
		.replace(
			/\b([A-Z0-9_]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Z0-9_]{0,64}["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
			"$1[REDACTED]",
		)
		.replace(
			/([?&](?:X-Amz-(?:Signature|Credential|Security-Token)|X-Goog-(?:Signature|Credential)|sig|signature|token|api[_-]?key|key)=)[^&#\s]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
			"[REDACTED]",
		)
		.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
		.trim();

	const lines = text.split("\n");
	const truncated =
		captureTruncated ||
		lines.length > DISPLAY_LINES ||
		text.length > DISPLAY_CHARACTERS;
	text = lines.slice(-DISPLAY_LINES).join("\n").slice(-DISPLAY_CHARACTERS);
	const heading = `Git command failed (exit ${status ?? "unknown"}).`;
	if (!text)
		return `${heading}\nNo diagnostic text was captured; check the terminal output.`;
	return `${heading}\n${truncated ? "[Last output only]\n" : ""}${text}`;
}
