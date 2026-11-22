import { stripVTControlCharacters } from "node:util";

// Redact common credential patterns in display and model-facing text.
export function redactSecrets(text: string): string {
	return text
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
			/(?<![A-Z0-9_-])([A-Z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Z0-9_-]{0,64}(?:\\*["'])?\s*[=:]\s*)(?:\\\\\\"(?:[^"\\\n]|\\{8}|\\{7}"|\\{4}[^"\\\n]|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\\\\\"|\\*(?="|\n|$))|\\\\"(?:[^"\\\n]|\\{4}|\\{3}"|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\\\"|\\*(?="|\n|$))|\\"(?:[^"\\\n]|\\{4}|\\{3}"|\\{2}[^"\\\n]|\\[^"\\\n])*(?:\\"|\\*(?="|\n|$))|"(?:[^"\\\n]|\\[^\n])*(?:"|\\?(?=\n|$))|\\'(?:[^'\\\n]|\\{2}|\\[^'\\\n])*(?:\\'|\\*(?='|\n|$))|'[^'\n]*(?:'|(?=\n)|$)|[^\s,;"'\\})\]>]+)/gi,
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
		.replace(/(https?:\/\/)[^\s/?#"\\<>]+@/gi, "$1[REDACTED]@");
}

// Strip terminal control characters and redact credentials for display.
function clean(text: string): string {
	return redactSecrets(
		stripVTControlCharacters(text)
			.replace(/\r\n?/g, "\n")
			.replace(/[\p{Cc}\p{Cf}]/gu, (character: string): string =>
				character === "\n" || character === "\t" ? character : "",
			),
	)
		.replace(/^\n+/, "")
		.trimEnd();
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
	// Drop a trailing partial word that might lack a credential's identifying suffix.
	const head =
		text.length > 1024 ? text.slice(0, 1024).replace(/\S+$/u, "") : text;
	const label = clean(head).replace(/\s+/gu, " ").trim();
	if (!label) {
		return text.length > 1024 && clean(text).trim() ? "…" : "";
	}
	return label.length > limit || text.length > 1024
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
