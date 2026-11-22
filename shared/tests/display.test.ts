import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayLabel, displayTail, redactSecrets } from "../display.ts";

describe("redactSecrets", () => {
	describe("happy paths (non-secret text)", () => {
		it("leaves ordinary prose, code, emails, and non-credential URLs untouched", () => {
			const samples = [
				"Build succeeded in 1.42s with 0 warnings.",
				'{"name":"pi-extensions","version":"1.0.0","enabled":true}',
				"Contact maintainers at support@example.com for details.",
				"https://example.com/api/v1/items?page=2&limit=50#results",
				"const count = 42; // normal assignment",
				"NotBearer abc123def456 and MyBasic dXNlcjpwYXNz==",
				"Short lookalikes: sk-short123 ghp_tooshort AKIA12345678901",
				"file:///Users/dev/project/test@2x.png",
				'{"tokens": []}',
				"secrets:\n  - public_item_1\n  - public_item_2",
			];
			for (const sample of samples) {
				assert.equal(redactSecrets(sample), sample);
			}
		});

		it("is idempotent when applied repeatedly to already-redacted output", () => {
			const inputs = [
				"token=abc123",
				'{"password": "my-secret"}',
				'{"tokens": ["secret-one", "secret-two"]}',
				"Authorization: Bearer eyJabc123",
				"https://api.example.com/v1?token=t3&client_secret=s4&page=1#access_token=f5&state=ok",
				"https://user:pass@example.com/repo",
				"postgres://dbuser:dbpass@localhost:5432/app",
				"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				"-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----",
			];
			for (const input of inputs) {
				const once = redactSecrets(input);
				assert.equal(redactSecrets(once), once);
			}
		});
	});

	describe("PEM private keys", () => {
		it("redacts full PEM and PGP blocks of multiple key types while preserving surrounding text", () => {
			const rsa =
				"before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA12345\nline2\n-----END RSA PRIVATE KEY-----\nafter";
			assert.equal(redactSecrets(rsa), "before\n[REDACTED PRIVATE KEY]\nafter");

			const openssh =
				"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----";
			assert.equal(redactSecrets(openssh), "[REDACTED PRIVATE KEY]");

			const generic =
				"-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----";
			assert.equal(redactSecrets(generic), "[REDACTED PRIVATE KEY]");

			const encrypted =
				"-----BEGIN ENCRYPTED PRIVATE KEY-----\nencrypted-body\n-----END ENCRYPTED PRIVATE KEY-----";
			assert.equal(redactSecrets(encrypted), "[REDACTED PRIVATE KEY]");

			const pgp =
				"-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYB...\n-----END PGP PRIVATE KEY BLOCK-----";
			assert.equal(redactSecrets(pgp), "[REDACTED PRIVATE KEY]");
		});

		it("redacts truncated PEM blocks missing END or missing BEGIN", () => {
			const missingEnd =
				"header\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabcdef";
			assert.equal(redactSecrets(missingEnd), "header\n[REDACTED PRIVATE KEY]");

			const missingBegin =
				"leftover-base64-lines\nmore-key-data\n-----END PRIVATE KEY-----\ntrailer";
			assert.equal(
				redactSecrets(missingBegin),
				"[REDACTED PRIVATE KEY]\ntrailer",
			);
		});

		it("redacts multiple PEM blocks in the same string without swallowing text between them", () => {
			const text = [
				"first:",
				"-----BEGIN RSA PRIVATE KEY-----",
				"key-one-body",
				"-----END RSA PRIVATE KEY-----",
				"middle-safe-text",
				"-----BEGIN EC PRIVATE KEY-----",
				"key-two-body",
				"-----END EC PRIVATE KEY-----",
				"end",
			].join("\n");
			assert.equal(
				redactSecrets(text),
				"first:\n[REDACTED PRIVATE KEY]\nmiddle-safe-text\n[REDACTED PRIVATE KEY]\nend",
			);
		});
	});

	describe("Bearer and Basic authorization headers", () => {
		it("redacts Bearer and Basic tokens case-insensitively with padding and URL-safe chars", () => {
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
				redactSecrets("authorization: bearer my.token-value_1"),
				"authorization: bearer [REDACTED]",
			);
			assert.equal(redactSecrets("BASIC YWRtaW46c2VjcmV0"), "BASIC [REDACTED]");
		});

		it("respects word boundaries before Bearer and Basic", () => {
			const safe = "CustomBearer abc123 and NonBasic xyz789";
			assert.equal(redactSecrets(safe), safe);
		});
	});

	describe("key-value credential patterns", () => {
		it("redacts all supported key names with both = and : separators", () => {
			const keys = [
				"password",
				"passwd",
				"passphrase",
				"secret",
				"token",
				"api_key",
				"api-key",
				"apikey",
				"access_key",
				"access-key",
				"accesskey",
				"private_key",
				"private-key",
				"signing_key",
				"master_key",
				"encryption_key",
				"client_key",
			];
			for (const key of keys) {
				assert.equal(redactSecrets(`${key}=mySecret123`), `${key}=[REDACTED]`);
				assert.equal(
					redactSecrets(`${key.toUpperCase()}: mySecret123`),
					`${key.toUpperCase()}: [REDACTED]`,
				);
			}
		});

		it("redacts double-quoted, single-quoted, escaped single-quoted, and inline array secret values", () => {
			assert.equal(
				redactSecrets('{"password": "my \\"quoted\\" secret", "ok": 1}'),
				'{"password": [REDACTED], "ok": 1}',
			);
			assert.equal(
				redactSecrets("password='my single quoted secret' next=ok"),
				"password=[REDACTED] next=ok",
			);
			assert.equal(
				redactSecrets("password='abc\\'leaked' next=ok"),
				"password=[REDACTED] next=ok",
			);
			assert.equal(
				redactSecrets('{"tokens": ["tok-1", "tok-2"], "count": 2}'),
				'{"tokens": [REDACTED], "count": 2}',
			);
			assert.equal(
				redactSecrets("secrets: ['s1', 's2']"),
				"secrets: [REDACTED]",
			);
			assert.equal(
				redactSecrets('secret="unterminated-value\nnext-line=safe'),
				"secret=[REDACTED]\nnext-line=safe",
			);
			assert.equal(
				redactSecrets("token='unterminated-single\nnext-line=safe"),
				"token=[REDACTED]\nnext-line=safe",
			);
			assert.equal(
				redactSecrets('token="trailing-backslash\\'),
				"token=[REDACTED]",
			);
		});

		it("redacts single, double, and triple JSON-escaped quotes and escaped single quotes", () => {
			// Single JSON-escaped quotes: \"password\":\"val\"
			const singleJson = String.raw`{\"password\":\"sec\\\"ret\\\\val\",\"user\":\"alice\"}`;
			assert.equal(
				redactSecrets(singleJson),
				String.raw`{\"password\":[REDACTED],\"user\":\"alice\"}`,
			);

			// Double JSON-escaped quotes: \\"secret\\":\\"val\\" (inner escaped quote is \\\")
			const doubleJson = String.raw`{\\"secret\\":\\"top\\\"secret\\\\x\\",\\"ok\\":true}`;
			assert.equal(
				redactSecrets(doubleJson),
				String.raw`{\\"secret\\":[REDACTED],\\"ok\\":true}`,
			);

			// Triple JSON-escaped quotes: \\\"api_key\\\":\\\"val\\\" (inner escaped quote is \\\\\\\")
			const tripleJson = String.raw`{\\\"api_key\\\":\\\"deep\\\\\\\"secret\\\\\\\"value\\\",\\\"ok\\\":1}`;
			assert.equal(
				redactSecrets(tripleJson),
				String.raw`{\\\"api_key\\\":[REDACTED],\\\"ok\\\":1}`,
			);

			// Escaped single quotes: \'token\':\'val\'
			const escapedSingle = String.raw`\'token\':\'my \\\'secret\\\' val\', next=1`;
			assert.equal(
				redactSecrets(escapedSingle),
				String.raw`\'token\':[REDACTED], next=1`,
			);
		});

		it("stops unquoted values before delimiters (, } ] > ; ))", () => {
			assert.equal(
				redactSecrets("{token:abc123,keep:yes}"),
				"{token:[REDACTED],keep:yes}",
			);
			assert.equal(redactSecrets("{secret:xyz789}"), "{secret:[REDACTED]}");
			assert.equal(redactSecrets("[password=s3cr3t]"), "[password=[REDACTED]]");
			assert.equal(redactSecrets("<api_key=k999>"), "<api_key=[REDACTED]>");
			assert.equal(
				redactSecrets("passwd=hunter2;host=db.local"),
				"passwd=[REDACTED];host=db.local",
			);
			assert.equal(
				redactSecrets("(access_key=mykey)"),
				"(access_key=[REDACTED])",
			);
		});

		it("redacts keys with >64-char hyphenated and word prefixes as well as suffixed keys", () => {
			const longHyphenPrefix = `${"my-long-prefix-segment-".repeat(4)}api-key`;
			assert.ok(longHyphenPrefix.length > 80);
			assert.equal(
				redactSecrets(`${longHyphenPrefix}=supersecretvalue`),
				`${longHyphenPrefix}=[REDACTED]`,
			);

			const longWordPrefix = `${"service_prod_region_cluster_".repeat(3)}password`;
			assert.ok(longWordPrefix.length > 80);
			assert.equal(
				redactSecrets(`${longWordPrefix}: "hidden-pass"`),
				`${longWordPrefix}: [REDACTED]`,
			);

			const suffixedKey = `secret_${"x".repeat(60)}`;
			assert.equal(
				redactSecrets(`${suffixedKey}=myval`),
				`${suffixedKey}=[REDACTED]`,
			);
		});
	});

	describe("signed URL query and fragment parameters", () => {
		it("redacts AWS, Google, OAuth fragment, and prefixed auth parameters while keeping other params", () => {
			const awsUrl =
				"https://bucket.s3.amazonaws.com/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F2026&X-Amz-Security-Token=FwoGZXIvYXdz&X-Amz-Signature=deadbeef1234#frag";
			assert.equal(
				redactSecrets(awsUrl),
				"https://bucket.s3.amazonaws.com/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Amz-Signature=[REDACTED]#frag",
			);

			const gcpUrl =
				"https://storage.googleapis.com/b/o?X-Goog-Credential=svc@proj&X-Goog-Signature=abcd9876&download=1";
			assert.equal(
				redactSecrets(gcpUrl),
				"https://storage.googleapis.com/b/o?X-Goog-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&download=1",
			);

			const genericUrl =
				"https://api.example.com/v1?sig=s1&signature=s2&token=t3&api_key=k4&api-key=k5&apikey=k6&key=k7&client_secret=s8&page=1#access_token=f9&state=xyz";
			assert.equal(
				redactSecrets(genericUrl),
				"https://api.example.com/v1?sig=[REDACTED]&signature=[REDACTED]&token=[REDACTED]&api_key=[REDACTED]&api-key=[REDACTED]&apikey=[REDACTED]&key=[REDACTED]&client_secret=[REDACTED]&page=1#access_token=[REDACTED]&state=xyz",
			);
		});
	});

	describe("standalone provider tokens", () => {
		it("redacts OpenAI/Anthropic, Stripe, GitHub, GitLab, Slack, AWS, and age tokens", () => {
			const tokens = [
				"sk-proj_1234567890abcdef",
				"sk_live_0123456789abcdefghij",
				"rk_live_0123456789abcdefghij",
				"ghp_1234567890abcdefghij",
				"gho_ABCDEFGHIJ0123456789",
				"ghu_0123456789abcdefghij",
				"ghs_0123456789abcdefghij",
				"ghr_0123456789abcdefghij",
				"github_pat_11AAABBBCCC_0123456789abcdef",
				"glpat-1234567890abcdefghij",
				"xoxb-1234567890-1234567890-abcdef",
				"AKIAIOSFODNN7EXAMPLE",
				"ASIAIOSFODNN7EXAMPLE",
				`AGE-SECRET-KEY-1${"Q".repeat(58)}`,
			];
			for (const token of tokens) {
				assert.equal(
					redactSecrets(`Found ${token} in logs`),
					"Found [REDACTED] in logs",
					`expected ${token} to be redacted`,
				);
			}
		});

		it("does not redact tokens that fail minimum length or AKIA/ASIA exact length", () => {
			const nonTokens = [
				"sk-123456789012345",
				"ghp_1234567890123456789",
				"github_pat_1234567890123456789",
				"AKIA123456789012345",
				"AKIA12345678901234567",
				"ASIA12345678901234567",
			];
			for (const value of nonTokens) {
				assert.equal(redactSecrets(value), value);
			}
		});
	});

	describe("URI userinfo", () => {
		it("redacts user:password in http/https and database/service URIs including passwords containing @", () => {
			assert.equal(
				redactSecrets("git clone https://alice:s3cr3t@github.com/org/repo.git"),
				"git clone https://[REDACTED]@github.com/org/repo.git",
			);
			assert.equal(
				redactSecrets("http://tokenonly@internal.local/status"),
				"http://[REDACTED]@internal.local/status",
			);
			assert.equal(
				redactSecrets("https://user:p@ss@w0rd!@git.example.com/team/app.git"),
				"https://[REDACTED]@git.example.com/team/app.git",
			);
			assert.equal(
				redactSecrets("postgres://admin:s3cr3t@db.internal:5432/prod"),
				"postgres://[REDACTED]@db.internal:5432/prod",
			);
			assert.equal(
				redactSecrets("redis://:redispass@cache.internal:6379/0"),
				"redis://[REDACTED]@cache.internal:6379/0",
			);
			assert.equal(
				redactSecrets("mongodb+srv://svc:pa55@cluster0.example.net/app"),
				"mongodb+srv://[REDACTED]@cluster0.example.net/app",
			);
		});

		it("does not match across path, query, fragment, whitespace, or delimiters to a later @", () => {
			const samples = [
				"https://example.com/path/user@host",
				"https://example.com?email=user@host",
				"https://example.com#section@1",
				"https://example.com email@host.com",
				'{"url":"https://example.com","email":"a@b.com"}',
				"{'url':'https://example.com','email':'a@b.com'}",
			];
			for (const sample of samples) {
				assert.equal(redactSecrets(sample), sample);
			}
		});
	});

	describe("ReDoS timing budget", () => {
		it("completes in under 250ms per 50k+ char adversarial payload", () => {
			const payloads: Array<{ name: string; input: string }> = [
				{
					name: "unterminated double-quoted secret",
					input: `password="${"a".repeat(60_000)}`,
				},
				{
					name: "unterminated single-quoted secret with escapes",
					input: `password='${"\\'".repeat(30_000)}`,
				},
				{
					name: "unclosed array secret",
					input: `tokens=[${'"a", '.repeat(12_000)}`,
				},
				{
					name: "single JSON-escaped backslash flood",
					input: `password=\\"${"\\\\".repeat(25_000)}"x`,
				},
				{
					name: "double JSON-escaped backslash flood",
					input: `password=\\\\"${"\\\\".repeat(25_000)}"x`,
				},
				{
					name: "triple JSON-escaped backslash flood",
					input: `password=\\\\\\"${"\\\\\\\\".repeat(12_500)}"x`,
				},
				{
					name: "key with 60k backslashes and no separator",
					input: `password${"\\".repeat(60_000)}"x`,
				},
				{
					name: "URL without @",
					input: `https://${"a".repeat(60_000)}`,
				},
				{
					name: "PEM without END",
					input: `-----BEGIN PRIVATE KEY-----${"A".repeat(60_000)}`,
				},
				{
					name: "repeated password tokens without =",
					input: "password ".repeat(10_000),
				},
				{
					name: "repeated Bearer without value",
					input: "Bearer ".repeat(10_000),
				},
			];

			for (const { name, input } of payloads) {
				assert.ok(input.length >= 50_000, `${name} should be >= 50k chars`);
				const start = performance.now();
				const result = redactSecrets(input);
				const elapsedMs = performance.now() - start;
				assert.equal(typeof result, "string");
				assert.ok(
					elapsedMs < 250,
					`${name} took ${elapsedMs.toFixed(2)}ms (budget: <250ms)`,
				);
			}
		});
	});
});

describe("displayLabel", () => {
	it("returns clean normal text unchanged when within limit", () => {
		assert.equal(displayLabel("git status --short", 80), "git status --short");
		assert.equal(displayLabel("exact", 5), "exact");
	});

	it("collapses whitespace and strips ANSI/VT, C0, and Cf characters", () => {
		const raw =
			"\x1b[32mhello\x1b[0m\r\n\t  \u200bworld\x07\u202e\ufeff   \x00test\r\n";
		assert.equal(displayLabel(raw, 80), "hello world test");
	});

	it("redacts secrets even when broken up by ANSI escape sequences", () => {
		assert.equal(
			displayLabel(
				"curl -H 'Authorization: Bearer \x1b[31msecretTok123\x1b[0m'",
				80,
			),
			"curl -H 'Authorization: Bearer [REDACTED]'",
		);
		assert.equal(
			displayLabel("token\x1b[0m=mysecretvalue", 80),
			"token=[REDACTED]",
		);
	});

	it("redacts headless PEM blocks whose END marker appears past 1024 characters even with ANSI or zero-width chars", () => {
		const body = `${"MIIEpAIBAAKCAQEA".repeat(80)}\n`;
		for (const footer of [
			"-----END RSA PRIVATE KEY-----",
			"-----END RSA PRIVATE \x1b[31mK\x1b[0mEY-----",
			"-----END RSA PRIVATE\u200b KEY-----",
		]) {
			const headlessPem = `${body}${footer}\nafter`;
			assert.ok(headlessPem.indexOf("-----END") > 1024);
			const label = displayLabel(headlessPem, 120);
			assert.ok(
				!label.includes("MIIEpAIBAAKCAQEA"),
				`PEM body leaked: ${label}`,
			);
			assert.match(label, /\[REDACTED PRIVATE KEY\]/);
		}
	});

	it("truncates text exceeding limit with ellipsis", () => {
		assert.equal(displayLabel("abcdefghij", 6), "abcde…");
		assert.equal(displayLabel("abcdef", 1), "…");
		assert.equal(displayLabel("abcdef", 0), "…");
	});

	it("drops trailing partial word past 1024 chars to avoid leaking partial credentials", () => {
		// Secret straddles the 1024-char boundary; the partial word must be dropped.
		const padding = "word ".repeat(203); // 1015 chars
		const text = `${padding}sk-1234567890abcdef1234567890`;
		assert.ok(text.length > 1024);
		const label = displayLabel(text, 2000);
		assert.ok(!label.includes("sk-"), `partial secret leaked: ${label}`);
		assert.ok(label.endsWith("…"));
	});

	it("handles >1024-char and >16k-char single-word and whitespace-only inputs", () => {
		assert.equal(displayLabel("a".repeat(1030), 40), "…");
		assert.equal(displayLabel(`sk-${"a".repeat(1030)}`, 40), "…");
		assert.equal(displayLabel(" ".repeat(1100), 40), "");
		assert.equal(displayLabel(" ".repeat(50_000), 40), "");
		assert.equal(displayLabel("\x1b[31m\x00\u200b\n\t  ", 40), "");
		assert.equal(displayLabel("", 40), "");
	});

	it("preserves UTF-16 surrogate pair boundaries on truncation", () => {
		// "ab😀cd": code units are a(0), b(1), \uD83D(2), \uDE00(3), c(4), d(5)
		const text = "ab😀cd";
		// limit=4 => slice(0, 3) ends on high surrogate \uD83D -> trimmed to "ab" + "…"
		const cutInsidePair = displayLabel(text, 4);
		assert.equal(cutInsidePair, "ab…");
		assert.equal(cutInsidePair.isWellFormed(), true);
		assert.ok(!cutInsidePair.includes("\uFFFD"));

		// limit=5 => slice(0, 4) keeps full emoji -> "ab😀…"
		const afterPair = displayLabel(text, 5);
		assert.equal(afterPair, "ab😀…");
		assert.equal(afterPair.isWellFormed(), true);
	});

	it("converts pre-existing lone surrogates into well-formed strings", () => {
		const malformed = "bad\uD800pair";
		const result = displayLabel(malformed, 40);
		assert.equal(result.isWellFormed(), true);
		assert.equal(result, "bad\uFFFDpair");
	});
});

describe("displayTail", () => {
	it("returns clean multi-line output without header when within bounds", () => {
		const input = "\n\n\x1b[36mline 1\x1b[0m\r\n\tline 2\u200b\rline 3   \n";
		assert.equal(
			displayTail(input, false, "(empty)"),
			"line 1\n\tline 2\nline 3",
		);
	});

	it("redacts secrets in tail output", () => {
		assert.equal(
			displayTail("ok\nAPI_KEY=topsecret123\ndone", false, "(empty)"),
			"ok\nAPI_KEY=[REDACTED]\ndone",
		);
	});

	it("drops the partial first line and adds truncation header when cut=true", () => {
		const text =
			"partial_secret_suffix_without_prefix\nsecond line\nthird line";
		assert.equal(
			displayTail(text, true, "(no output)"),
			"[Last output only]\nsecond line\nthird line",
		);
	});

	it("falls back to empty message with header when cut=true has no newline", () => {
		assert.equal(
			displayTail("only-one-partial-line", true, "(no output)"),
			"[Last output only]\n(no output)",
		);
	});

	it("enforces the 20-line cap", () => {
		const exact20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		assert.equal(displayTail(exact20, false, "(empty)"), exact20);

		const lines25 = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const expectedLast20 = Array.from(
			{ length: 20 },
			(_, i) => `line ${i + 6}`,
		).join("\n");
		assert.equal(
			displayTail(lines25, false, "(empty)"),
			`[Last output only]\n${expectedLast20}`,
		);
	});

	it("enforces the 4000-char cap", () => {
		const exact4000 = "x".repeat(4000);
		assert.equal(displayTail(exact4000, false, "(empty)"), exact4000);

		const over4000 = `PREFIX${"y".repeat(4000)}`;
		assert.equal(
			displayTail(over4000, false, "(empty)"),
			`[Last output only]\n${"y".repeat(4000)}`,
		);
	});

	it("trims a dangling leading low surrogate when slicing at the 4000-char boundary", () => {
		// 3 + 2 (emoji) + 3999 = 4004 chars; slice(-4000) starts on low surrogate \uDE00
		const text = `${"a".repeat(3)}😀${"b".repeat(3999)}`;
		const result = displayTail(text, false, "(empty)");
		assert.equal(result, `[Last output only]\n${"b".repeat(3999)}`);
		assert.equal(result.isWellFormed(), true);
		assert.ok(!result.includes("\uFFFD"));
	});

	it("returns the empty fallback for empty or control-only output", () => {
		assert.equal(displayTail("", false, "(no output)"), "(no output)");
		assert.equal(
			displayTail("  \n\t\x1b[33m\x00\u200b  ", false, "(no output)"),
			"(no output)",
		);
		assert.equal(
			displayTail("partial\n   \x1b[0m", true, "(no output)"),
			"[Last output only]\n(no output)",
		);
	});
});
