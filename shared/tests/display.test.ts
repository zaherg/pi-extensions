import assert from "node:assert/strict";
import test from "node:test";
import { displayTail, redactSecrets } from "../display.ts";

test("redacts the credential forms shared by display and model-bound text", () => {
	const cases: [string, string][] = [
		["Authorization: Bearer abc.def-123", "Authorization: Bearer [REDACTED]"],
		["API_KEY=hunter2 next", "API_KEY=[REDACTED] next"],
		["https://x.test/?sig=abc&ok=1", "https://x.test/?sig=[REDACTED]&ok=1"],
		["key sk-abcdefghijklmnopqrstu end", "key [REDACTED] end"],
		["https://user:pass@host/x", "https://[REDACTED]@host/x"],
		// Forms the progress redactor used to miss:
		["clone https://ghtokenvalue123@github.com/o/r", "clone https://[REDACTED]@github.com/o/r"],
		['password = "unterminated value\nnext', "password = [REDACTED]\nnext"],
		["abc\nMIIE...\n-----END RSA PRIVATE KEY-----\nafter", "[REDACTED PRIVATE KEY]\nafter"],
		[
			"a\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\nb",
			"a\n[REDACTED PRIVATE KEY]\nb",
		],
	];
	for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected);
});

test("redactSecrets keeps layout; display output also strips controls", () => {
	assert.equal(redactSecrets("\n  plain\r\n"), "\n  plain\r\n");
	assert.equal(displayTail("\u001b[31mtoken=abc\u001b[0m\r\n", false, "-"), "token=[REDACTED]");
});
