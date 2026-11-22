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

describe("resolvePath", () => {
	const cwd = "/workspace/project";

	it("resolves relative paths against cwd", () => {
		assert.equal(
			resolvePath("src/index.ts", cwd),
			resolve(cwd, "src/index.ts"),
		);
		assert.equal(
			resolvePath("./nested/../lib/util.ts", cwd),
			resolve(cwd, "lib/util.ts"),
		);
	});

	it("preserves and normalizes absolute paths", () => {
		assert.equal(resolvePath("/etc/hosts", cwd), resolve("/etc/hosts"));
		assert.equal(
			resolvePath("/var/log/../tmp/out.txt", cwd),
			resolve("/var/tmp/out.txt"),
		);
	});

	it("expands bare ~ and ~/... to homedir", () => {
		assert.equal(resolvePath("~", cwd), resolve(homedir()));
		assert.equal(
			resolvePath("~/notes/todo.md", cwd),
			resolve(homedir(), "notes/todo.md"),
		);
	});

	it("does not expand ~otheruser prefixes", () => {
		assert.equal(
			resolvePath("~otheruser/file.txt", cwd),
			resolve(cwd, "~otheruser/file.txt"),
		);
	});

	it("strips leading @ before expanding ~ or resolving", () => {
		assert.equal(
			resolvePath("@src/app.ts", cwd),
			resolve(cwd, "src/app.ts"),
		);
		assert.equal(resolvePath("@/abs/file.ts", cwd), resolve("/abs/file.ts"));
		assert.equal(resolvePath("@~", cwd), resolve(homedir()));
		assert.equal(
			resolvePath("@~/config/app.json", cwd),
			resolve(homedir(), "config/app.json"),
		);
	});
});

describe("fileClass", () => {
	it("classifies all supported lockfile names regardless of directory", () => {
		const lockfiles = [
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
		];
		for (const name of lockfiles) {
			assert.equal(fileClass(name), "lockfile", name);
			assert.equal(fileClass(`/repo/sub/${name}`), "lockfile", `/repo/sub/${name}`);
		}
	});

	it("classifies minified bundles and JS/CSS sourcemaps as minified", () => {
		for (const path of [
			"dist/app.min.js",
			"dist/app.min.mjs",
			"dist/app.min.cjs",
			"dist/styles.min.css",
			"dist/app.js.map",
			"dist/styles.css.map",
		]) {
			assert.equal(fileClass(path), "minified", path);
		}
		assert.equal(fileClass("src/app.min.ts"), "text");
		assert.equal(fileClass("dist/data.map"), "text");
		assert.equal(fileClass("src/min.js"), "text");
	});

	it("classifies .log and rotated numeric logs as log", () => {
		assert.equal(fileClass("/var/log/app.log"), "log");
		assert.equal(fileClass("/var/log/app.log.1"), "log");
		assert.equal(fileClass("/var/log/app.log.42"), "log");
		assert.equal(fileClass("/var/log/app.log.gz"), "text");
		assert.equal(fileClass("src/logger.ts"), "text");
	});

	it("classifies plain .json files as json and normal code as text", () => {
		assert.equal(fileClass("tsconfig.json"), "json");
		assert.equal(fileClass("/repo/data/config.json"), "json");
		assert.equal(fileClass("events.jsonl"), "text");
		assert.equal(fileClass("src/index.ts"), "text");
		assert.equal(fileClass("README.md"), "text");
		assert.equal(fileClass("Makefile"), "text");
	});
});

describe("parseReadView", () => {
	it("parses plain multi-line body with default start line 1", () => {
		const view = parseReadView("alpha\nbeta\ngamma", undefined);
		assert.deepEqual(view, {
			start: 1,
			body: "alpha\nbeta\ngamma",
			lines: ["alpha", "beta", "gamma"],
		});
		assert.equal("notice" in (view ?? {}), false);
	});

	it("applies valid positive integer offsets including widened read offsets", () => {
		const view = parseReadView("line 42\nline 43", 42);
		assert.deepEqual(view, {
			start: 42,
			body: "line 42\nline 43",
			lines: ["line 42", "line 43"],
		});
	});

	it("falls back to start 1 for invalid or non-positive offsets", () => {
		for (const bad of [
			0,
			-5,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			"10",
			null,
		]) {
			const view = parseReadView("hello", bad);
			assert.equal(view?.start, 1, `offset=${String(bad)}`);
		}
	});

	it("separates Pi Showing lines continuation notices with and without reason", () => {
		const notice1 = "[Showing lines 1-200 of 500. Use offset=201 to continue.]";
		const view1 = parseReadView(`line1\nline2\n\n${notice1}`, 1);
		assert.deepEqual(view1, {
			start: 1,
			body: "line1\nline2",
			lines: ["line1", "line2"],
			notice: notice1,
		});

		const notice2 =
			"[Showing lines 10-80 of 500 (50KB limit). Use offset=81 to continue.]";
		const view2 = parseReadView(`a\nb\n\n${notice2}`, 10);
		assert.deepEqual(view2, {
			start: 10,
			body: "a\nb",
			lines: ["a", "b"],
			notice: notice2,
		});
	});

	it("separates Pi 'more lines in file' continuation notice", () => {
		const notice = "[42 more lines in file. Use offset=101 to continue.]";
		const view = parseReadView(`first\nsecond\n\n${notice}`, 50);
		assert.deepEqual(view, {
			start: 50,
			body: "first\nsecond",
			lines: ["first", "second"],
			notice,
		});
	});

	it("does not strip notices lacking a preceding blank line or not at EOF", () => {
		const noBlank =
			"line1\n[42 more lines in file. Use offset=101 to continue.]";
		const view1 = parseReadView(noBlank, 1);
		assert.equal(view1?.body, noBlank);
		assert.equal(view1?.notice, undefined);

		const midFile =
			"line1\n\n[42 more lines in file. Use offset=101 to continue.]\ntrailing";
		const view2 = parseReadView(midFile, 1);
		assert.equal(view2?.body, midFile);
		assert.equal(view2?.notice, undefined);
	});

	it("returns undefined for single-line Pi [Line ...] out-of-range messages", () => {
		assert.equal(
			parseReadView("[Line 500 is beyond end of file (120 lines)]", 500),
			undefined,
		);
	});

	it("parses multi-line text even if the first line starts with '[Line '", () => {
		const view = parseReadView("[Line 1]\nsecond line", 1);
		assert.deepEqual(view, {
			start: 1,
			body: "[Line 1]\nsecond line",
			lines: ["[Line 1]", "second line"],
		});
	});

	it("parses empty text as a single empty line", () => {
		assert.deepEqual(parseReadView("", undefined), {
			start: 1,
			body: "",
			lines: [""],
		});
	});
});

describe("bashFileView", () => {
	const cwd = "/workspace/repo";

	it("recognizes single-file cat, head, tail, sed, nl, and rtk read commands", () => {
		const cases: [string, string][] = [
			["cat src/a.ts", resolve(cwd, "src/a.ts")],
			["  cat 'path with spaces/a.ts'  ", resolve(cwd, "path with spaces/a.ts")],
			['cat "src/b.ts"', resolve(cwd, "src/b.ts")],
			["cat ~/notes.txt", resolve(homedir(), "notes.txt")],
			["head src/a.ts", resolve(cwd, "src/a.ts")],
			["head -n 20 src/a.ts", resolve(cwd, "src/a.ts")],
			["head -n20 src/a.ts", resolve(cwd, "src/a.ts")],
			["head -20 src/a.ts", resolve(cwd, "src/a.ts")],
			["tail src/a.ts", resolve(cwd, "src/a.ts")],
			["tail -n 50 src/a.ts", resolve(cwd, "src/a.ts")],
			["tail -n50 src/a.ts", resolve(cwd, "src/a.ts")],
			["tail -50 src/a.ts", resolve(cwd, "src/a.ts")],
			["sed -n '1,50p' src/a.ts", resolve(cwd, "src/a.ts")],
			['sed -n "10p" src/a.ts', resolve(cwd, "src/a.ts")],
			["sed -n 1,20p src/a.ts", resolve(cwd, "src/a.ts")],
			["nl src/a.ts", resolve(cwd, "src/a.ts")],
			["nl -ba -w3 src/a.ts", resolve(cwd, "src/a.ts")],
			["rtk read src/a.ts", resolve(cwd, "src/a.ts")],
			["rtk read src/a.ts --head-lines 50", resolve(cwd, "src/a.ts")],
			["rtk read src/a.ts --tail-lines 25", resolve(cwd, "src/a.ts")],
		];
		for (const [command, expected] of cases) {
			assert.equal(bashFileView(command, cwd), expected, command);
		}
	});

	it("resolves files relative to a leading cd && prefix", () => {
		assert.equal(
			bashFileView("cd packages/core && cat index.ts", cwd),
			resolve(cwd, "packages/core/index.ts"),
		);
		assert.equal(
			bashFileView("cd 'my dir' && head -n 10 sub/file.ts", cwd),
			resolve(cwd, "my dir/sub/file.ts"),
		);
		assert.equal(
			bashFileView("cd ~/proj && sed -n '1,5p' main.go", cwd),
			resolve(homedir(), "proj/main.go"),
		);
		assert.equal(
			bashFileView("cd packages/core && cat /etc/hosts", cwd),
			resolve("/etc/hosts"),
		);
	});

	it("rejects compound commands, pipes, redirects, multi-file reads, and unsupported flags", () => {
		const rejected = [
			"",
			"   ",
			"cat a.ts && echo done",
			"cat a.ts || true",
			"cat a.ts; ls",
			"cat a.ts | grep foo",
			"cat a.ts > out.txt",
			"cat < a.ts",
			"cat a.ts b.ts",
			"head -n 10 a.ts b.ts",
			"cat -n a.ts",
			"head -c 100 a.ts",
			"tail -f app.log",
			"sed -i 's/a/b/' a.ts",
			"rtk read a.ts --head-lines 10 --tail-lines 10",
			'cat "$TARGET"',
			"cat `echo a.ts`",
			"cat $(echo a.ts)",
			"cd a && cd b && cat c.ts",
			"grep foo a.ts",
			"ls -la",
		];
		for (const command of rejected) {
			assert.equal(bashFileView(command, cwd), undefined, command);
		}
	});
});

describe("lockfilePackages", () => {
	it("extracts packages from package-lock.json and npm-shrinkwrap.json while skipping non-package keys", () => {
		const lock = [
			"{",
			'  "name": "demo",',
			'  "packages": {',
			'    "": {',
			'      "version": "0.0.1",',
			'      "dependencies": {',
			'        "version": "ignored"',
			"      },",
			'      "engines": {',
			'        "version": "ignored"',
			"      }",
			"    },",
			'    "node_modules/lodash": {',
			'      "version": "4.17.21"',
			"    },",
			'    "node_modules/a/node_modules/@scope/pkg": {',
			'      "version": "2.3.4"',
			"    },",
			'    "node_modules/zod": {',
			'      "version": "3.23.8"',
			"    },",
			'    "node_modules/dup/node_modules/zod": {',
			'      "version": "3.23.8"',
			"    }",
			"  }",
			"}",
		].join("\n");

		assert.deepEqual(lockfilePackages("/repo/package-lock.json", lock), [
			"lodash@4.17.21",
			"@scope/pkg@2.3.4",
			"zod@3.23.8",
		]);
		assert.deepEqual(lockfilePackages("/repo/npm-shrinkwrap.json", lock), [
			"lodash@4.17.21",
			"@scope/pkg@2.3.4",
			"zod@3.23.8",
		]);
	});

	it("extracts packages from pnpm-lock.yaml", () => {
		const lock = [
			"packages:",
			"  /lodash@4.17.21:",
			"    resolution: {integrity: sha512-...}",
			"  '@types/node@22.10.0':",
			"    resolution: {integrity: sha512-...}",
			"  react-dom@18.3.1(react@18.3.1):",
			"    resolution: {integrity: sha512-...}",
		].join("\n");

		assert.deepEqual(lockfilePackages("pnpm-lock.yaml", lock), [
			"lodash@4.17.21",
			"@types/node@22.10.0",
			"react-dom@18.3.1",
		]);
	});

	it("extracts packages from Yarn v1 and Yarn Berry lockfiles", () => {
		const lock = [
			'lodash@^4.17.0:',
			'  version "4.17.21"',
			"",
			'"@babel/core@^7.24.0, @babel/core@^7.25.0":',
			'  version "7.25.2"',
			"",
			'"typescript@npm:^5.6.0":',
			"  version: 5.6.3",
		].join("\n");

		assert.deepEqual(lockfilePackages("yarn.lock", lock), [
			"lodash@4.17.21",
			"@babel/core@7.25.2",
			"typescript@5.6.3",
		]);
	});

	it("extracts packages from bun.lock", () => {
		const lock = [
			"{",
			'  "packages": {',
			'    "chalk": ["chalk@5.3.0", "", {}, "sha512-..."],',
			'    "@scope/cli": ["@scope/cli@1.2.3", "", {}, "sha512-..."],',
			'    "zod": ["zod@3.23.8", "", {}, "sha512-..."]',
			"  }",
			"}",
		].join("\n");

		assert.deepEqual(lockfilePackages("bun.lock", lock), [
			"chalk@5.3.0",
			"@scope/cli@1.2.3",
			"zod@3.23.8",
		]);
	});

	it("extracts packages from Cargo.lock, uv.lock, and poetry.lock", () => {
		const toml = [
			"[[package]]",
			'name = "serde"',
			'version = "1.0.210"',
			"",
			"[[package]]",
			'name = "tokio"',
			'version = "1.40.0"',
			"",
			"[[package]]",
			'name = "anyhow"',
			'version = "1.0.89"',
		].join("\n");

		for (const file of ["Cargo.lock", "uv.lock", "poetry.lock"]) {
			assert.deepEqual(
				lockfilePackages(`/repo/${file}`, toml),
				["serde@1.0.210", "tokio@1.40.0", "anyhow@1.0.89"],
				file,
			);
		}
	});

	it("extracts deduplicated packages from go.sum", () => {
		const goSum = [
			"golang.org/x/sys v0.18.0 h1:abc=",
			"golang.org/x/sys v0.18.0/go.mod h1:def=",
			"golang.org/x/text v0.14.0 h1:ghi=",
			"golang.org/x/net v0.22.0/go.mod h1:jkl=",
		].join("\n");

		assert.deepEqual(lockfilePackages("go.sum", goSum), [
			"golang.org/x/sys@v0.18.0",
			"golang.org/x/text@v0.14.0",
			"golang.org/x/net@v0.22.0",
		]);
	});

	it("extracts packages from composer.lock and Gemfile.lock", () => {
		const composer = [
			"        {",
			'            "name": "monolog/monolog",',
			'            "version": "3.7.0",',
			"        },",
			"        {",
			'            "name": "psr/log",',
			'            "version": "3.0.2"',
			"        },",
			"        {",
			'            "name": "symfony/console",',
			'            "version": "v7.1.0",',
			"        }",
		].join("\n");

		assert.deepEqual(lockfilePackages("composer.lock", composer), [
			"monolog/monolog@3.7.0",
			"psr/log@3.0.2",
			"symfony/console@v7.1.0",
		]);

		const gemfile = [
			"GEM",
			"  specs:",
			"    rack (3.1.7)",
			"    rake (13.2.1)",
			"    rspec-core (3.13.0)",
		].join("\n");

		assert.deepEqual(lockfilePackages("Gemfile.lock", gemfile), [
			"rack@3.1.7",
			"rake@13.2.1",
			"rspec-core@3.13.0",
		]);
	});

	it("returns [] for fewer than 3 unique packages, unknown files, empty, or malformed inputs", () => {
		const twoUnique = [
			"golang.org/x/sys v0.18.0 h1:abc=",
			"golang.org/x/sys v0.18.0/go.mod h1:def=",
			"golang.org/x/text v0.14.0 h1:ghi=",
			"golang.org/x/text v0.14.0/go.mod h1:jkl=",
		].join("\n");
		assert.deepEqual(lockfilePackages("go.sum", twoUnique), []);
		assert.deepEqual(lockfilePackages("README.md", twoUnique), []);
		assert.deepEqual(lockfilePackages("package-lock.json", ""), []);
		assert.deepEqual(
			lockfilePackages("Cargo.lock", '[[package]]\nname = "only-name"\nnot valid'),
			[],
		);
	});
});

describe("stripJsonIndentation", () => {
	it("removes leading spaces and tabs per line while preserving internal spacing", () => {
		const input = '{\n  "a": "  keep  ",\n\t\t"b": [\n\t  1,\n\t  2\n  ]\n}';
		assert.equal(
			stripJsonIndentation(input),
			'{\n"a": "  keep  ",\n"b": [\n1,\n2\n]\n}',
		);
	});

	it("returns unindented text unchanged", () => {
		const input = '{"a": 1}\n{"b": 2}';
		assert.equal(stripJsonIndentation(input), input);
	});
});

describe("truncateLongLines", () => {
	it("leaves lines at or under 300 code units untouched", () => {
		const exact300 = "x".repeat(300);
		assert.equal(truncateLongLines(`short\n${exact300}`), `short\n${exact300}`);
	});

	it("truncates lines longer than 300 code units with exact omitted count", () => {
		const line301 = "a".repeat(301);
		assert.equal(
			truncateLongLines(line301),
			`${"a".repeat(300)}…[+1 chars]`,
		);
		const multi = `ok\n${"b".repeat(350)}\nend`;
		assert.equal(
			truncateLongLines(multi),
			`ok\n${"b".repeat(300)}…[+50 chars]\nend`,
		);
	});

	it("does not split a UTF-16 surrogate pair straddling the 300-code-unit boundary", () => {
		const emoji = "😀"; // 2 UTF-16 code units: \uD83D\uDE00
		const straddling = `${"a".repeat(299)}${emoji}z`;
		assert.equal(straddling.length, 302);

		const truncated = truncateLongLines(straddling);
		assert.equal(truncated.isWellFormed(), true);
		assert.equal(truncated, `${"a".repeat(299)}…[+3 chars]`);
	});

	it("keeps a UTF-16 surrogate pair that ends cleanly at index 299", () => {
		const emoji = "😀";
		const aligned = `${"a".repeat(298)}${emoji}z`;
		assert.equal(aligned.length, 301);

		const truncated = truncateLongLines(aligned);
		assert.equal(truncated.isWellFormed(), true);
		assert.equal(truncated, `${"a".repeat(298)}${emoji}…[+1 chars]`);
	});

	it("normalizes pre-existing lone surrogates to well-formed strings on short and long lines", () => {
		const shortLone = `abc\uD800def`;
		const shortOut = truncateLongLines(shortLone);
		assert.equal(shortOut.isWellFormed(), true);
		assert.equal(shortOut, "abc\uFFFDdef");

		const longLone = `${"x".repeat(10)}\uDC00${"y".repeat(310)}`;
		const longOut = truncateLongLines(longLone);
		assert.equal(longOut.isWellFormed(), true);
		assert.ok(longOut.endsWith("…[+21 chars]"));
	});
});

describe("splitBashTrailer", () => {
	it("returns only body when no Pi bash trailer is present", () => {
		const res = splitBashTrailer("hello\nworld");
		assert.deepEqual(res, { body: "hello\nworld" });
		assert.equal("trailer" in res, false);
	});

	it("splits a trailing Pi full-output truncation notice", () => {
		const trailer = "[Showing last 2000 lines of 5000. Full output: /tmp/out.txt]";
		assert.deepEqual(splitBashTrailer(`line1\nline2\n\n${trailer}`), {
			body: "line1\nline2",
			trailer,
		});
	});

	it("splits a trailing non-zero exit code notice", () => {
		const trailer = "Command exited with code 1";
		assert.deepEqual(splitBashTrailer(`err output\n\n${trailer}`), {
			body: "err output",
			trailer,
		});
	});

	it("splits both truncation notice and exit code notice together", () => {
		const trailer =
			"[Showing last 100 lines. Full output: /tmp/out.log]\n\nCommand exited with code 2";
		assert.deepEqual(splitBashTrailer(`payload\n\n${trailer}`), {
			body: "payload",
			trailer,
		});
	});

	it("does not split notices without a preceding blank line or in the middle of output", () => {
		const noBlank = "payload\nCommand exited with code 1";
		assert.deepEqual(splitBashTrailer(noBlank), { body: noBlank });

		const middle = "payload\n\nCommand exited with code 1\nmore text";
		assert.deepEqual(splitBashTrailer(middle), { body: middle });
	});
});
