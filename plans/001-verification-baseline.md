# Plan 001: Add zero-install typecheck and Biome verification baseline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2545142..HEAD -- package.json tsconfig.json .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `2545142`, 2026-11-21

## Why this matters

`package.json` declares `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as `peerDependencies` without installing a local `node_modules/`, while `tsconfig.json` specifies `"types": ["node"]`. As a result, running `tsc --noEmit` in a checkout or worktree fails immediately (`TS2688: Cannot find type definition file for 'node'`), leaving subsequent plans without a one-command typecheck + lint gate. Adding a zero-install `npm run check` script that resolves declarations from local `./node_modules` when present or from the installed Pi release (`$PI_CODING_AGENT_DIR` / `~/.pi/agent/install/current-version`) via a temporary `os.tmpdir()` `tsconfig`, followed by `biome lint .` and `.gitignore` coverage for `.verification/`, gives every plan a fast, non-mutating verification baseline.

## Current state

- `package.json` (lines 1–28) — package manifest with no `scripts` block:
  ```json
  {
    "name": "@zaherg/pi-extensions",
    "private": true,
    "type": "module",
    "license": "MIT",
    "engines": {
      "node": ">=22.19.0"
    },
    "peerDependencies": {
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      "typebox": "*"
    },
    "pi": {
      "extensions": [
        "./exit.ts",
        "./git/index.ts",
        "./wip.ts",
        "./phpstorm-mcp/index.ts",
        "./progress/index.ts",
        "./rtk-pi-extended/index.ts",
        "./rtk-gain/index.ts",
        "./trace/index.ts",
        "./worker-board/index.ts"
      ]
    }
  }
  ```
- `tsconfig.json` (lines 1–28) — strict TypeScript 6 config (note TypeScript 6 rejects `baseUrl` with `TS5102`, and already excludes `**/.verification/**`):
  ```json
  {
      "compilerOptions": {
          "target": "ESNext",
          "module": "NodeNext",
          "moduleResolution": "NodeNext",
          "allowImportingTsExtensions": true,
          "noEmit": true,
          "strict": true,
          "noUncheckedIndexedAccess": true,
          "exactOptionalPropertyTypes": true,
          "noImplicitReturns": true,
          "noFallthroughCasesInSwitch": true,
          "noImplicitOverride": true,
          "noUnusedLocals": true,
          "noUnusedParameters": true,
          "skipLibCheck": true,
          "types": [
              "node"
          ]
      },
      "include": [
          "**/*.ts"
      ],
      "exclude": [
          "node_modules",
          "**/.verification/**"
      ]
  }
  ```
- `.gitignore` (lines 1–7):
  ```gitignore
  .ruff_cache/
  .serena/
  .codegraph/
  .pi/

  node_modules/
  skills/
  ```
- Repo conventions:
  - Ponytail minimalism: no new npm dependencies, no helper script files in the repo when a short `scripts.check` entry suffices, and disposable verification tests are always deleted before finishing.
  - Note on Biome: the repo has no `biome.json`, so `biome check .` invokes Biome's unconfigured default formatter across Markdown/JSON/TS files; `biome lint .` enforces lint rules cleanly across the repo with 0 errors.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck + Lint | `npm run check` | exit 0, 0 errors |
| Lint JSON | `biome lint package.json tsconfig.json` | exit 0, 0 errors |

## Scope

**In scope** (the only files you should modify):
- `package.json`
- `.gitignore`

**Out of scope** (do NOT touch):
- `tsconfig.json` — keep strict compiler options unchanged so editor tooling with `node_modules` continues to use it directly.
- Any `.ts` extension file or `README.md` (covered in later plans).
- Installing `node_modules` or `package-lock.json` into the repository.

## Git workflow

- Branch: `advisor/001-004-trace-worker-board` (create from `HEAD` if not already on it).
- Commit once all steps pass with concise imperative commit subject matching `git log` (e.g. `Add zero-install typecheck and lint script`).
- Do NOT push or open a PR.

## Steps

### Step 1: Ignore `.verification/` in `.gitignore`

Append `.verification/` to `.gitignore` so temporary disposable test harnesses created during plan verification can never be staged accidentally (note: executors must still delete `.verification/` before completing any plan).

**Verify**: `git check-ignore -q .verification/probe.test.ts && echo OK` → `OK`

### Step 2: Add `scripts.check` to `package.json`

Add a `"scripts"` block to `package.json` with `"check"` running:
1. A compact inline `node -e` command that:
   - Checks if `./node_modules/@types/node` exists; if so, runs `tsc --noEmit` directly (`stdio: "inherit"`).
   - Otherwise resolves `agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent")` and `piMods = process.env.PI_MODULES || path.join(agentDir, "install/releases", fs.readFileSync(path.join(agentDir, "install/current-version"), "utf8").trim(), "node_modules")`, writes a temporary config in `os.tmpdir()` (`pi-ext-tsconfig-${process.pid}.json`) with `extends: path.resolve("tsconfig.json")`, `compilerOptions.typeRoots: [path.join(piMods, "@types")]`, `compilerOptions.paths` mapping `@earendil-works/pi-ai` (`dist/index.d.ts`), `@earendil-works/pi-coding-agent` (`dist/index.d.ts`), `@earendil-works/pi-tui` (`dist/index.d.ts`), and `typebox` (`build/index.d.mts`), `include: [path.resolve("**/*.ts")]`, and `exclude: [path.resolve("node_modules"), path.resolve("**/.verification/**")]` (do **not** set `baseUrl`, which fails in TypeScript 6), runs `tsc -p <tmpCfg> --noEmit` with `stdio: "inherit"`, and always unlinks `<tmpCfg>` in `finally`.
2. Followed by `&& biome lint --files-ignore-unknown=true .` (using `biome lint` rather than `biome check` because the repo intentionally ships no `biome.json` formatter config, and `.gitignore` + `--files-ignore-unknown=true` skips non-code files cleanly).

**Verify**: `npm run check` → exits 0 with 0 TypeScript errors and 0 Biome lint errors.

### Step 3: Verify `.verification/` exclusion and clean up

Create `.verification/probe.ts` with unused code, confirm `npm run check` ignores `.verification/` (via `--vcs-enabled=true --vcs-use-ignore-file=true` on `biome lint` or `.gitignore`), confirm no `pi-ext-tsconfig-*.json` remains in `os.tmpdir()`, then delete `.verification/`.

**Verify**: `rm -rf .verification && npm run check && test ! -d .verification && echo CLEAN` → `CLEAN`

## Test plan

- Verify `npm run check` succeeds on clean `HEAD` without `node_modules/`.
- Verify `git check-ignore -q .verification/test.ts` exits 0.
- Ensure `.verification/` does **not** exist when finished (`test ! -d .verification`).

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `biome lint package.json` exits 0
- [ ] `git check-ignore -q .verification/probe.ts` exits 0
- [ ] `test ! -d .verification` exits 0 (no test files left behind)
- [ ] Only `package.json` and `.gitignore` are modified in this commit (`git diff --name-only HEAD~1..HEAD`)

## STOP conditions

- `package.json` or `.gitignore` does not match the "Current state" excerpts.
- Installed Pi release modules cannot be found under `~/.pi/agent/install/releases/` and `PI_MODULES` is unset.
- `npm run check` fails twice after fixing syntax/lint flags.
- Fixing typecheck requires modifying any `.ts` file outside scope.

## Maintenance notes

- If a new peer dependency is added to `package.json`, add its `.d.ts`/`.d.mts` entry to the `paths` map in `package.json`'s `scripts.check`.
- Never add `baseUrl` to the generated `tsconfig` (removed in TypeScript 6).
