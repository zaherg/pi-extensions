import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
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

const CWD = "/work/app";

test("splits Pi's read continuation notices from the file lines", () => {
	const notices = [
		"[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]",
		"[Showing lines 10-900 of 9000 (50.0KB limit). Use offset=901 to continue.]",
		"[123 more lines in file. Use offset=300 to continue.]",
	];
	for (const notice of notices) {
		const view = parseReadView(`a\nb\n\n${notice}`, 10);
		assert.deepEqual(
			view,
			{ start: 10, body: "a\nb", lines: ["a", "b"], notice },
			notice,
		);
	}
	// A file whose own text ends like a notice without the blank line is all body.
	assert.equal(
		parseReadView("a\n[1 more lines in file. Use offset=3 to continue.]", 1)
			?.notice,
		undefined,
	);
	assert.deepEqual(parseReadView("x\ny", undefined), {
		start: 1,
		body: "x\ny",
		lines: ["x", "y"],
	});
	for (const offset of [0, -3, 1.5, "7", Number.NaN])
		assert.equal(parseReadView("x", offset)?.start, 1, String(offset));
	// Pi's message for an oversized first line carries no file lines.
	assert.equal(
		parseReadView(
			"[Line 1 is 80.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.min.js | head -c 51200]",
			1,
		),
		undefined,
	);
});

test("splits Pi's Bash truncation notice from a file view", () => {
	const notice =
		"[Showing lines 1-2000 of 9000. Full output: /tmp/pi-bash-1.log]";
	assert.deepEqual(splitBashTrailer(`body\n\n${notice}`), {
		body: "body",
		trailer: notice,
	});
	assert.deepEqual(
		splitBashTrailer("body\n[Showing lines 1-2 of 3. Full output: x]"),
		{
			body: "body\n[Showing lines 1-2 of 3. Full output: x]",
		},
	);
});

test("resolves paths like Pi's read tool", () => {
	assert.equal(resolvePath("src/a.ts", CWD), "/work/app/src/a.ts");
	assert.equal(resolvePath("@src/a.ts", CWD), "/work/app/src/a.ts");
	assert.equal(resolvePath("../b/./c.ts", CWD), "/work/b/c.ts");
	assert.equal(resolvePath("~/x.json", CWD), `${homedir()}/x.json`);
	assert.equal(resolvePath("/etc/hosts", CWD), "/etc/hosts");
});

test("classifies only non-code files for condensation", () => {
	const classes: [string, string][] = [
		["bun.lock", "lockfile"],
		["/a/package-lock.json", "lockfile"],
		["Cargo.lock", "lockfile"],
		["go.sum", "lockfile"],
		["dist/app.min.js", "minified"],
		["dist/app.min.css", "minified"],
		["dist/app.js.map", "minified"],
		["logs/server.log", "log"],
		["logs/server.log.3", "log"],
		["data.json", "json"],
		["package.json", "json"],
		["src/a.ts", "text"],
		["README.md", "text"],
		["app.min.ts", "text"],
		["changelog", "text"],
	];
	for (const [path, expected] of classes)
		assert.equal(fileClass(path), expected, path);
});

test("finds the file a Bash command only prints", () => {
	const views: [string, string | undefined][] = [
		["cat a.ts", "/work/app/a.ts"],
		["  cat 'my file.ts'  ", "/work/app/my file.ts"],
		['cd "sub dir" && cat x.json', "/work/app/sub dir/x.json"],
		["cd /srv && head -n 20 log.log", "/srv/log.log"],
		["tail -20 a.log", "/work/app/a.log"],
		["sed -n '5p' a.ts", "/work/app/a.ts"],
		['sed -n "1,80p" a.ts', "/work/app/a.ts"],
		["rtk read a.ts", "/work/app/a.ts"],
		["rtk read a.log --tail-lines 20", "/work/app/a.log"],
		["nl -ba -w3 a.ts", "/work/app/a.ts"],
		["cat ~/notes.md", `${homedir()}/notes.md`],
		// Anything else is a command, not a file view.
		["cat a.ts b.ts", undefined],
		["cat a.ts | head", undefined],
		["cat $HOME/a", undefined],
		["cat `which x`", undefined],
		["sed -n '1,5p;9p' a.ts", undefined],
		["sed -i 's/a/b/' a.ts", undefined],
		["cat a.ts > b.ts", undefined],
		["cd x && cd y && cat a", undefined],
		["cat", undefined],
	];
	for (const [command, path] of views)
		assert.equal(bashFileView(command, CWD), path, command);
});

test("trims only long lines and marks each trim", () => {
	const long = "x".repeat(305);
	assert.equal(
		truncateLongLines(`short\n${long}\n${"y".repeat(300)}`),
		`short\n${"x".repeat(300)}…[+5 chars]\n${"y".repeat(300)}`,
	);
});

test("removes only leading whitespace from JSON lines", () => {
	assert.equal(
		stripJsonIndentation('{\n  "a": "  b",\n\t"c": [\n    1\n  ]\n}'),
		'{\n"a": "  b",\n"c": [\n1\n]\n}',
	);
});

// Excerpts shaped like each tool's real output.
const LOCKFILES: [string, string, string[]][] = [
	[
		"bun.lock",
		`{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "react": "^18.2.0",
      },
    },
  },
  "packages": {
    "@types/node": ["@types/node@22.1.0", "", { "dependencies": { "undici-types": "~6.13.0" } }, "sha512-AAA"],
    "loose-envify": ["loose-envify@1.4.0", "", { "bin": { "loose-envify": "cli.js" } }, "sha512-BBB"],
    "react": ["react@18.2.0", "", { "dependencies": { "loose-envify": "^1.1.0" } }, "sha512-CCC"],
  }
}`,
		["@types/node@22.1.0", "loose-envify@1.4.0", "react@18.2.0"],
	],
	[
		"package-lock.json",
		`{
  "name": "app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "app",
      "version": "1.0.0",
      "dependencies": {
        "react": "^18.2.0"
      }
    },
    "node_modules/@babel/core/node_modules/semver": {
      "version": "6.3.1",
      "bin": {
        "semver": "bin/semver.js"
      }
    },
    "node_modules/loose-envify": {
      "version": "1.4.0",
      "resolved": "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz",
      "integrity": "sha512-AAA",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/react": {
      "version": "18.2.0",
      "dependencies": {
        "loose-envify": "^1.1.0"
      }
    }
  }
}`,
		["semver@6.3.1", "loose-envify@1.4.0", "react@18.2.0"],
	],
	[
		"npm-shrinkwrap.json",
		`{
  "lockfileVersion": 1,
  "dependencies": {
    "a": {
      "version": "1.0.0",
      "requires": {
        "b": "^2.0.0"
      },
      "dependencies": {
        "b": {
          "version": "2.0.0"
        }
      }
    },
    "c": {
      "version": "3.0.0"
    }
  }
}`,
		["a@1.0.0", "b@2.0.0", "c@3.0.0"],
	],
	[
		"yarn.lock",
		`# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.22.13":
  version "7.22.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.22.13.tgz"
  integrity sha512-AAA
  dependencies:
    "@babel/highlight" "^7.22.13"

js-tokens@^4.0.0:
  version "4.0.0"

loose-envify@^1.1.0:
  version "1.4.0"
`,
		["@babel/code-frame@7.22.13", "js-tokens@4.0.0", "loose-envify@1.4.0"],
	],
	[
		"yarn.lock",
		`__metadata:
  version: 8
  cacheKey: 10

"js-tokens@npm:^3.0.0 || ^4.0.0":
  version: 4.0.0
  resolution: "js-tokens@npm:4.0.0"

"loose-envify@npm:^1.1.0":
  version: 1.4.0

"@types/node@npm:*":
  version: 22.1.0
`,
		["js-tokens@4.0.0", "loose-envify@1.4.0", "@types/node@22.1.0"],
	],
	[
		"pnpm-lock.yaml",
		`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.2.0

packages:

  '@babel/code-frame@7.22.13':
    resolution: {integrity: sha512-AAA}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-BBB}

  react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-CCC}

snapshots:

  js-tokens@4.0.0: {}
`,
		["@babel/code-frame@7.22.13", "js-tokens@4.0.0", "react-dom@18.2.0"],
	],
	[
		"Cargo.lock",
		`# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "anyhow"
version = "1.0.75"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "a4668cab"

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "anyhow",
]

[[package]]
name = "regex"
version = "1.10.2"
`,
		["anyhow@1.0.75", "app@0.1.0", "regex@1.10.2"],
	],
	[
		"poetry.lock",
		`[[package]]
name = "certifi"
version = "2023.7.22"
description = "Python package for providing Mozilla's CA Bundle."
optional = false
files = [
    {file = "certifi-2023.7.22-py3-none-any.whl", hash = "sha256:AAA"},
]

[[package]]
name = "idna"
version = "3.4"

[[package]]
name = "requests"
version = "2.31.0"

[metadata]
lock-version = "2.0"
`,
		["certifi@2023.7.22", "idna@3.4", "requests@2.31.0"],
	],
	[
		"uv.lock",
		`version = 1
requires-python = ">=3.12"

[[package]]
name = "anyio"
version = "4.4.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "idna" },
]

[[package]]
name = "idna"
version = "3.7"

[[package]]
name = "sniffio"
version = "1.3.1"
`,
		["anyio@4.4.0", "idna@3.7", "sniffio@1.3.1"],
	],
	[
		"composer.lock",
		`{
    "content-hash": "abc",
    "packages": [
        {
            "name": "monolog/monolog",
            "version": "3.5.0",
            "authors": [
                {
                    "name": "Jordi Boggiano",
                    "email": "j.boggiano@seld.be"
                }
            ]
        },
        {
            "name": "psr/log",
            "version": "3.0.0"
        },
        {
            "name": "symfony/console",
            "version": "v7.0.1",
            "source": {
                "type": "git"
            }
        }
    ]
}`,
		["monolog/monolog@3.5.0", "psr/log@3.0.0", "symfony/console@v7.0.1"],
	],
	[
		"Gemfile.lock",
		`GEM
  remote: https://rubygems.org/
  specs:
    actioncable (7.1.2)
      actionpack (= 7.1.2)
      nio4r (~> 2.0)
    nokogiri (1.15.4-x86_64-linux)
    rack (3.0.8)

PLATFORMS
  ruby

DEPENDENCIES
  rails (~> 7.1)
`,
		["actioncable@7.1.2", "nokogiri@1.15.4-x86_64-linux", "rack@3.0.8"],
	],
	[
		"go.sum",
		`github.com/pkg/errors v0.9.1 h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=
github.com/pkg/errors v0.9.1/go.mod h1:bwawxfHBFNV+L2hUp1rHADufV3IMtnDRdf1r5NINEl0=
golang.org/x/sys v0.15.0 h1:AAA=
golang.org/x/text v0.14.0/go.mod h1:BBB=
`,
		[
			"github.com/pkg/errors@v0.9.1",
			"golang.org/x/sys@v0.15.0",
			"golang.org/x/text@v0.14.0",
		],
	],
];

test("extracts name@version entries from each lockfile format", () => {
	for (const [name, text, expected] of LOCKFILES)
		assert.deepEqual(
			lockfilePackages(`/repo/${name}`, text),
			expected,
			`${name}: ${expected[0]}`,
		);
});

test("refuses lockfile excerpts with too few entries and unknown names", () => {
	assert.deepEqual(
		lockfilePackages("/repo/go.sum", "a v1.0.0 h1:x=\nb v2.0.0 h1:y=\n"),
		[],
	);
	assert.deepEqual(
		lockfilePackages(
			"/repo/deps.lock",
			"a v1.0.0 h1:x=\nb v2.0.0 h1:y=\nc v1 h1:z=\n",
		),
		[],
	);
});
