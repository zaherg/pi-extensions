import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
	bashFileView,
	fileClass,
	lockfilePackages,
	parseReadView,
	resolvePath,
	splitBashTrailer,
	stripJsonIndentation,
	truncateLongLines,
} from "../views.ts";

describe("resolvePath & fileClass", () => {
	it("resolves relative, absolute, ~, and @-prefixed paths without expanding ~otheruser", () => {
		const cwd = "/workspace/project";
		assert.equal(
			resolvePath("src/index.ts", cwd),
			resolve(cwd, "src/index.ts"),
		);
		assert.equal(resolvePath("/etc/hosts", cwd), resolve("/etc/hosts"));
		assert.equal(resolvePath("~", cwd), resolve(homedir()));
		assert.equal(
			resolvePath("@~/config/app.json", cwd),
			resolve(homedir(), "config/app.json"),
		);
		assert.equal(
			resolvePath("~otheruser/file.txt", cwd),
			resolve(cwd, "~otheruser/file.txt"),
		);
	});

	it("classifies lockfile, minified, log, json, and text paths", () => {
		for (const lock of [
			"bun.lock",
			"package-lock.json",
			"npm-shrinkwrap.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"Cargo.lock",
			"composer.lock",
			"Gemfile.lock",
			"poetry.lock",
			"uv.lock",
			"go.sum",
		]) {
			assert.equal(fileClass(`/repo/${lock}`), "lockfile", lock);
		}
		assert.equal(fileClass("dist/app.min.js"), "minified");
		assert.equal(fileClass("dist/app.js.map"), "minified");
		assert.equal(fileClass("/var/log/app.log.1"), "log");
		assert.equal(fileClass("/var/log/app.log.gz"), "text");
		assert.equal(fileClass("tsconfig.json"), "json");
		assert.equal(fileClass("events.jsonl"), "text");
	});
});

describe("parseReadView & splitBashTrailer", () => {
	it("parses offsets, separates EOF continuation notices, and skips out-of-range notices", () => {
		const notice = "[Showing lines 10-80 of 500. Use offset=81 to continue.]";
		assert.deepEqual(parseReadView(`a\nb\n\n${notice}`, 10), {
			start: 10,
			body: "a\nb",
			lines: ["a", "b"],
			notice,
		});
		assert.equal(parseReadView("hello", 0)?.start, 1);
		assert.equal(parseReadView("hello", "10")?.start, 1);
		assert.equal(parseReadView(`line1\n${notice}`, 1)?.notice, undefined);
		assert.equal(
			parseReadView("[Line 500 is beyond end of file (120 lines)]", 500),
			undefined,
		);
	});

	it("splits trailing Pi truncation and exit-code trailers only after a blank line at EOF", () => {
		const trailer =
			"[Showing last 100 lines. Full output: /tmp/out.log]\n\nCommand exited with code 2";
		assert.deepEqual(splitBashTrailer(`payload\n\n${trailer}`), {
			body: "payload",
			trailer,
		});
		assert.deepEqual(splitBashTrailer("payload\nCommand exited with code 1"), {
			body: "payload\nCommand exited with code 1",
		});
	});
});

describe("bashFileView", () => {
	it("recognizes single-file views (including leading cd &&) and rejects compound/unsafe commands", () => {
		const cwd = "/workspace/repo";
		const accepted: [string, string][] = [
			["cat 'path with spaces/a.ts'", resolve(cwd, "path with spaces/a.ts")],
			["head -n 20 src/a.ts", resolve(cwd, "src/a.ts")],
			["tail -50 src/a.ts", resolve(cwd, "src/a.ts")],
			["sed -n '1,50p' src/a.ts", resolve(cwd, "src/a.ts")],
			["nl -ba src/a.ts", resolve(cwd, "src/a.ts")],
			["rtk read src/a.ts --head-lines 50", resolve(cwd, "src/a.ts")],
			[
				"cd packages/core && cat index.ts",
				resolve(cwd, "packages/core/index.ts"),
			],
		];
		for (const [cmd, expected] of accepted) {
			assert.equal(bashFileView(cmd, cwd), expected, cmd);
		}

		for (const bad of [
			"cat a.ts | grep foo",
			"cat a.ts b.ts",
			"cat -n a.ts",
			"tail -f app.log",
			"sed -i 's/a/b/' a.ts",
			'cat "$TARGET"',
			"cat $(echo a.ts)",
			"cd a && cd b && cat c.ts",
		]) {
			assert.equal(bashFileView(bad, cwd), undefined, bad);
		}
	});
});

describe("lockfilePackages", () => {
	it("extracts packages across lockfile formats and requires at least 3 unique packages", () => {
		const npmLock = JSON.stringify(
			{
				name: "demo",
				packages: {
					"": { version: "0.0.1", dependencies: { version: "ignored" } },
					"node_modules/lodash": { version: "4.17.21" },
					"node_modules/a/node_modules/@scope/pkg": { version: "2.3.4" },
					"node_modules/zod": { version: "3.23.8" },
				},
			},
			null,
			2,
		);
		assert.deepEqual(lockfilePackages("package-lock.json", npmLock), [
			"lodash@4.17.21",
			"@scope/pkg@2.3.4",
			"zod@3.23.8",
		]);

		assert.deepEqual(
			lockfilePackages(
				"pnpm-lock.yaml",
				"packages:\n  /lodash@4.17.21:\n    resolution: {}\n  '@types/node@22.10.0':\n    resolution: {}\n  react-dom@18.3.1(react@18.3.1):\n    resolution: {}",
			),
			["lodash@4.17.21", "@types/node@22.10.0", "react-dom@18.3.1"],
		);

		assert.deepEqual(
			lockfilePackages(
				"yarn.lock",
				'lodash@^4.17.0:\n  version "4.17.21"\n\n"@babel/core@^7.24.0":\n  version "7.25.2"\n\n"typescript@npm:^5.6.0":\n  version: 5.6.3',
			),
			["lodash@4.17.21", "@babel/core@7.25.2", "typescript@5.6.3"],
		);

		assert.deepEqual(
			lockfilePackages(
				"bun.lock",
				'{\n  "packages": {\n    "chalk": ["chalk@5.3.0"],\n    "@scope/cli": ["@scope/cli@1.2.3"],\n    "zod": ["zod@3.23.8"]\n  }\n}',
			),
			["chalk@5.3.0", "@scope/cli@1.2.3", "zod@3.23.8"],
		);

		const toml =
			'[[package]]\nname = "serde"\nversion = "1.0.210"\n[[package]]\nname = "tokio"\nversion = "1.40.0"\n[[package]]\nname = "anyhow"\nversion = "1.0.89"';
		assert.deepEqual(lockfilePackages("Cargo.lock", toml), [
			"serde@1.0.210",
			"tokio@1.40.0",
			"anyhow@1.0.89",
		]);

		assert.deepEqual(
			lockfilePackages(
				"go.sum",
				"golang.org/x/sys v0.18.0 h1:a=\ngolang.org/x/sys v0.18.0/go.mod h1:b=\ngolang.org/x/text v0.14.0 h1:c=\ngolang.org/x/net v0.22.0 h1:d=",
			),
			[
				"golang.org/x/sys@v0.18.0",
				"golang.org/x/text@v0.14.0",
				"golang.org/x/net@v0.22.0",
			],
		);

		assert.deepEqual(
			lockfilePackages(
				"composer.lock",
				'        {\n            "name": "monolog/monolog",\n            "version": "3.7.0"\n        },\n        {\n            "name": "psr/log",\n            "version": "3.0.2"\n        },\n        {\n            "name": "symfony/console",\n            "version": "v7.1.0"\n        }',
			),
			["monolog/monolog@3.7.0", "psr/log@3.0.2", "symfony/console@v7.1.0"],
		);

		assert.deepEqual(
			lockfilePackages(
				"Gemfile.lock",
				"GEM\n  specs:\n    rack (3.1.7)\n    rake (13.2.1)\n    rspec-core (3.13.0)",
			),
			["rack@3.1.7", "rake@13.2.1", "rspec-core@3.13.0"],
		);

		// < 3 unique packages returns []
		assert.deepEqual(
			lockfilePackages("go.sum", "golang.org/x/sys v0.18.0 h1:a="),
			[],
		);
	});
});

describe("stripJsonIndentation & truncateLongLines", () => {
	it("strips leading indentation and truncates >300-unit lines without splitting surrogate pairs", () => {
		assert.equal(
			stripJsonIndentation('{\n  "a": "  keep  ",\n\t"b": 1\n}'),
			'{\n"a": "  keep  ",\n"b": 1\n}',
		);

		const straddling = `${"a".repeat(299)}😀z`;
		const truncated = truncateLongLines(straddling);
		assert.equal(truncated.isWellFormed(), true);
		assert.equal(truncated, `${"a".repeat(299)}…[+3 chars]`);

		assert.equal(truncateLongLines("abc\uD800def"), "abc\uFFFDdef");
	});
});
