import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayLabel, displayTail, redactSecrets } from "../display.ts";

describe("redactSecrets", () => {
	it("leaves ordinary prose, code, emails, and non-credential URLs untouched", () => {
		const samples = [
			"Build succeeded in 1.42s with 0 warnings.",
			'{"name":"pi-extensions","version":"1.0.0","enabled":true}',
			"Contact maintainers at support@example.com for details.",
			"https://example.com/api/v1/items?page=2&limit=50#results",
			"NotBearer abc123def456 and MyBasic dXNlcjpwYXNz==",
			"Short lookalikes: sk-short123 ghp_tooshort AKIA12345678901",
			"https://example.com/path/user@host",
			'{"url":"https://example.com","email":"a@b.com"}',
			"API_KEY=\nNEXT_LINE=ok",
			"secret:\n  nested_key: ok",
		];
		for (const sample of samples) {
			assert.equal(redactSecrets(sample), sample);
		}
	});

	it("redacts full, truncated, and multiple PEM/PGP private key blocks", () => {
		const multi = [
			"first:",
			"-----BEGIN RSA PRIVATE KEY-----",
			"key-one-body",
			"-----END RSA PRIVATE KEY-----",
			"middle-safe-text",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----",
			"key-two-body",
			"-----END PGP PRIVATE KEY BLOCK-----",
			"end",
		].join("\n");
		assert.equal(
			redactSecrets(multi),
			"first:\n[REDACTED PRIVATE KEY]\nmiddle-safe-text\n[REDACTED PRIVATE KEY]\nend",
		);
		assert.equal(
			redactSecrets("header\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabcdef"),
			"header\n[REDACTED PRIVATE KEY]",
		);
		assert.equal(
			redactSecrets("leftover\n-----END PRIVATE KEY-----\ntrailer"),
			"[REDACTED PRIVATE KEY]\ntrailer",
		);
	});

	it("redacts Bearer/Basic headers, key-value credentials, JSON-escaped quotes, multiline values, and long-prefixed keys", () => {
		assert.equal(
			redactSecrets(
				"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc_123-def~456+789/0==",
			),
			"Authorization: Bearer [REDACTED]",
		);
		assert.equal(
			redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA=="),
			"Authorization: Basic [REDACTED]",
		);
		assert.equal(
			redactSecrets('{"password": "my \\"quoted\\" secret", "ok": 1}'),
			'{"password": [REDACTED], "ok": 1}',
		);
		assert.equal(
			redactSecrets("password='abc\\'leaked' {token:abc123,keep:yes}"),
			"password=[REDACTED] {token:[REDACTED],keep:yes}",
		);
		assert.equal(
			redactSecrets('{"tokens": ["tok-1", "tok-2"], "count": 2}'),
			'{"tokens": [REDACTED], "count": 2}',
		);
		const multilineJson = '{\n  "apiKey":\n    "super-secret-value-12345"\n}';
		const redactedMultilineJson = redactSecrets(multilineJson);
		assert.equal(redactedMultilineJson, '{\n  "apiKey":\n    [REDACTED]\n}');
		assert.equal(redactSecrets(redactedMultilineJson), redactedMultilineJson);

		const multilineYaml = "api_key:\n  unquoted_yaml_secret_99\nnext_key: ok";
		const redactedMultilineYaml = redactSecrets(multilineYaml);
		assert.equal(redactedMultilineYaml, "api_key:\n  [REDACTED]\nnext_key: ok");
		assert.equal(redactSecrets(redactedMultilineYaml), redactedMultilineYaml);

		assert.equal(
			redactSecrets(
				String.raw`{\"password\":\"sec\\\"ret\\\\val\",\"user\":\"alice\"}`,
			),
			String.raw`{\"password\":[REDACTED],\"user\":\"alice\"}`,
		);
		assert.equal(
			redactSecrets(
				String.raw`{\\\"api_key\\\":\\\"deep\\\\\\\"secret\\\\\\\"value\\\",\\\"ok\\\":1}`,
			),
			String.raw`{\\\"api_key\\\":[REDACTED],\\\"ok\\\":1}`,
		);
		const longKey = `${"my-long-prefix-segment-".repeat(4)}api-key`;
		assert.equal(
			redactSecrets(`${longKey}=supersecret`),
			`${longKey}=[REDACTED]`,
		);
	});

	it("redacts signed URL params, URI userinfo, and standalone provider tokens", () => {
		assert.equal(
			redactSecrets(
				"https://bucket.s3.amazonaws.com/f?X-Amz-Credential=AKIA%2F2026&X-Amz-Signature=deadbeef&keep=1#access_token=tok9",
			),
			"https://bucket.s3.amazonaws.com/f?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&keep=1#access_token=[REDACTED]",
		);
		assert.equal(
			redactSecrets("https://user:p@ss@w0rd!@git.example.com/team/app.git"),
			"https://[REDACTED]@git.example.com/team/app.git",
		);
		assert.equal(
			redactSecrets("postgres://admin:s3cr3t@db.internal:5432/prod"),
			"postgres://[REDACTED]@db.internal:5432/prod",
		);

		for (const token of [
			"sk-proj_1234567890abcdef",
			"sk_live_0123456789abcdefghij",
			"ghp_1234567890abcdefghij",
			"github_pat_11AAABBBCCC_0123456789abcdef",
			"glpat-1234567890abcdefghij",
			"xoxb-1234567890-1234567890-abcdef",
			"AKIAIOSFODNN7EXAMPLE",
			`AGE-SECRET-KEY-1${"Q".repeat(58)}`,
		]) {
			assert.equal(redactSecrets(`Found ${token}!`), "Found [REDACTED]!");
		}
	});

	it("stays within the 250ms ReDoS timing budget on 50k+ char adversarial inputs", () => {
		for (const input of [
			`password="${"a".repeat(60_000)}`,
			`password='${"\\'".repeat(30_000)}`,
			`password=\\"${"\\\\".repeat(25_000)}"x`,
			`https://${"a".repeat(60_000)}`,
			`-----BEGIN PRIVATE KEY-----${"A".repeat(60_000)}`,
		]) {
			const start = performance.now();
			redactSecrets(input);
			assert.ok(performance.now() - start < 250);
		}
	});
});

describe("displayLabel and displayTail", () => {
	it("strips ANSI/control chars, redacts ANSI-interleaved and multiline secrets and headless PEMs, and truncates safely", () => {
		assert.equal(
			displayLabel("\x1b[32mhello\x1b[0m\r\n\t \u200bworld\x07", 80),
			"hello world",
		);
		assert.equal(
			displayLabel("Authorization: Bearer \x1b[31msecretTok123\x1b[0m", 80),
			"Authorization: Bearer [REDACTED]",
		);
		assert.equal(
			displayLabel('{\n  "apiKey":\n    "super-secret-value-12345"\n}', 80),
			'{ "apiKey": [REDACTED] }',
		);
		const headlessPem = `${"MIIEpAIBAAKCAQEA".repeat(80)}\n-----END RSA PRIVATE \x1b[31mK\x1b[0mEY-----\nafter`;
		assert.ok(!displayLabel(headlessPem, 120).includes("MIIEpAIBAAKCAQEA"));

		// Drops partial trailing word past 1024 chars and preserves UTF-16 surrogate pairs
		const straddling = `${"word ".repeat(203)}sk-1234567890abcdef1234567890`;
		assert.ok(!displayLabel(straddling, 2000).includes("sk-"));
		assert.equal(displayLabel("ab😀cd", 4), "ab…");
		assert.equal(displayLabel("ab😀cd", 5), "ab😀…");
	});

	it("formats bounded tail output, drops cut partial first line, caps 20 lines / 4000 chars, and redacts", () => {
		assert.equal(
			displayTail("ok\nAPI_KEY=topsecret123\ndone\n", false, "(empty)"),
			"ok\nAPI_KEY=[REDACTED]\ndone",
		);
		assert.equal(
			displayTail("partial_first\nsecond\nthird", true, "(no output)"),
			"[Last output only]\nsecond\nthird",
		);
		assert.equal(
			displayTail("  \n\x1b[33m ", false, "(no output)"),
			"(no output)",
		);

		const lines25 = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const tail25 = displayTail(lines25, false, "(empty)");
		assert.ok(tail25.startsWith("[Last output only]\nline 6\n"));
		assert.ok(tail25.endsWith("\nline 25"));

		const over4000 = `${"a".repeat(3)}😀${"b".repeat(3999)}`;
		const tail4000 = displayTail(over4000, false, "(empty)");
		assert.equal(tail4000, `[Last output only]\n${"b".repeat(3999)}`);
		assert.equal(tail4000.isWellFormed(), true);
	});
});
