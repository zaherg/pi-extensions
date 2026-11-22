import { stripVTControlCharacters } from "node:util";

// Redact common credential patterns in display and model-facing text.
export function redactSecrets(text: string): string {
	return text
		.replace(
			/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(
			/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
		.replace(
			/([?&#](?:X-Amz-(?:Signature|Credential|Security-Token)|X-Goog-(?:Signature|Credential)|[A-Z0-9_-]{0,32}(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)|sig|signature|key)=)[^&#\s"'<>]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/((?:password|passwd|passphrase|secret|token|(?:api|access|private|signing|master|encryption|client)[_-]?key)[A-Z0-9_-]{0,64}(?:\\*["'])?[ \t]*[=:][ \t]*)(?:\\\\\\"(?:[^"\\\n]|\\{8}|\\{7}"|\\{4}[^"\\\n]|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\\\\\"|\\*(?="|\n|$))|\\\\"(?:[^"\\\n]|\\{4}|\\{3}"|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\\\"|\\*(?="|\n|$))|\\"(?:[^"\\\n]|\\{4}|\\{3}"|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\"|\\*(?="|\n|$))|"(?:[^"\\\n]|\\[^\n])*(?:"|\\?(?=\n|$))|\\'(?:[^'\\\n]|\\{4}|\\{3}'|\\{2}[^'\\\n]|\\[^'\\\n])*(?:\\'|\\*(?='|\n|$))|'(?:[^'\\\n]|\\[^\n])*(?:'|\\?(?=\n|$))|\[[ \t]*(?:"(?:[^"\\\n]|\\[^\n])*"|'(?:[^'\\\n]|\\[^\n])*'|\[REDACTED\])[ \t]*(?:,[ \t]*(?:"(?:[^"\\\n]|\\[^\n])*"|'(?:[^'\\\n]|\\[^\n])*'|\[REDACTED\])[ \t]*){0,64}\]|\[REDACTED\]|(?!\[[ \t]*\])[^\s,;"'\\})\]>]+)/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AGE-SECRET-KEY-1[A-Z0-9]{58})\b/g,
			"[REDACTED]",
		)
		.replace(
			/(\b[a-z][a-z0-9+.-]{1,31}:\/\/)[^\s/?#"'\\<>]+@/gi,
			"$1[REDACTED]@",
		);
}

/** Strip terminal escape sequences and unsafe control or format characters, preserving newlines and tabs. */
export function stripUnsafeText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (character: string): string =>
			character === "\n" || character === "\t" ? character : "",
		);
}

// Strip terminal control characters and redact credentials for display.
function clean(text: string): string {
	return redactSecrets(stripUnsafeText(text)).replace(/^\n+/, "").trimEnd();
}

const trimLeadLow = (s: string): string => {
	const code = s.charCodeAt(0);
	return code >= 0xdc00 && code <= 0xdfff ? s.slice(1) : s;
};
const trimTrailHigh = (s: string): string => {
	const code = s.charCodeAt(s.length - 1);
	return code >= 0xd800 && code <= 0xdbff ? s.slice(0, -1) : s;
};

export function displayLabel(text: string, limit: number): string {
	const bounded =
		text.length > 16_384 ? text.slice(0, 16_384).replace(/\S+$/u, "") : text;
	const stripped = stripUnsafeText(bounded);
	// Redact PEM blocks before the 1024-char slice so headless keys with a later END marker cannot leak.
	const source = stripped.includes("PRIVATE KEY")
		? redactSecrets(stripped)
		: stripped;
	// Drop a trailing partial word that might lack a credential's identifying suffix.
	const head =
		source.length > 1024 ? source.slice(0, 1024).replace(/\S+$/u, "") : source;
	const label = redactSecrets(head).replace(/\s+/gu, " ").trim();
	const wasCut = text.length > 16_384 || source.length > 1024;
	if (!label) {
		return wasCut && redactSecrets(source).trim() ? "…" : "";
	}
	return label.length > limit || wasCut
		? `${trimTrailHigh(label.slice(0, Math.max(0, limit - 1))).toWellFormed()}…`
		: label.toWellFormed();
}

export function displayTail(text: string, cut: boolean, empty: string): string {
	if (cut) {
		// Drop a partial first line that might lack a credential's identifying prefix.
		const newline = text.indexOf("\n");
		text = newline < 0 ? "" : text.slice(newline + 1);
	}
	text = clean(text);
	const lines = text.split("\n");
	const joined = lines.slice(-20).join("\n");
	const truncated = cut || lines.length > 20 || text.length > 4000;
	const tail = (
		joined.length > 4000 ? trimLeadLow(joined.slice(-4000)) : joined
	).toWellFormed();
	return `${truncated ? "[Last output only]\n" : ""}${tail || empty}`;
}
