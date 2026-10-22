# Toolchain standard

The same toolchain runs in every project of the fleet, and the files that carry it are **identical in
every repo of a profile**, so a change made once in the `fleet-stack` repo (`D:\Documents\Tools\fleet-stack`)
propagates by copying. This repo follows the **node** profile (Node/TypeScript services, libraries, CLIs and
React/Vite apps, single package or monorepo). This file is the reference and is itself one of the shared files.

## Runtime and package manager

- **Node 26** (LTS from 2026-10-28). Pinned in `engines.node` (`>=26.12.1`, the latest security release: raise it with every Node security release) and `.node-version`; Docker images use
  `node:26` (same variant as before) and install pnpm with `npm install -g pnpm@<version>` (Node 26 no longer
  bundles corepack). `engineStrict` is on, so installing on an older Node fails fast.
- **pnpm 12**, pinned in `packageManager` (the exact version). Never commit `package-lock.json` or `yarn.lock`.
  pnpm is strict: a package imports only what it declares.
- Build scripts of dependencies run only when approved: `allowBuilds` in `pnpm-workspace.yaml`.
- `pnpm-workspace.yaml` also holds the safety policy: `minimumReleaseAge` (a release must be a day old),
  `trustPolicy: no-downgrade`, `blockExoticSubdeps`, `strictDepBuilds`, `engineStrict`. Unknown keys fail
  the install on pnpm 12. Workspace `packages:` and `overrides:` live there too (npm's `overrides` field is
  ignored by pnpm).
- No `dotenv`: Node loads env files itself (`process.loadEnvFile()` guarded for a missing file, or
  `--env-file-if-exists=.env` in a script; `tsx` supports the flag too).

## Scripts

The same names everywhere. The first group has the same value in every repo (checked):

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `pnpm lint`         | `oxlint --type-aware`                                           |
| `pnpm format`       | `oxfmt` (writes)                                                |
| `pnpm format:check` | `oxfmt --check`                                                 |
| `pnpm check:stack`  | fails when this repo drifted from the standard (below)          |
| `pnpm check`        | typecheck + lint + format:check + check:stack                   |

The second group exists in every repo with the repo's own value (CI calls it):

| Script              | What it holds                                                                    |
| ------------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck`    | `tsc --noEmit` (per tsconfig, or `pnpm -r typecheck` / `turbo run typecheck`)    |
| `pnpm test`         | `vitest run` (or the monorepo equivalent)                                        |
| `pnpm build`        | the build (a library or a script-only repo may make it a no-op `echo`)           |
| `pnpm ci:prebuild`  | gates that run before the build (`echo` when there are none)                     |
| `pnpm ci:postbuild` | gates on the build output (`echo` when there are none)                           |
| `pnpm ci:e2e`       | browser tests including their browser install, or `echo` when the repo has none   |

## Lint and format

- **Oxlint** (`.oxlintrc.json`): correctness rules are errors, suspicious rules are warnings, a short list of noisy
  rules is off. Plugins: typescript, unicorn, oxc, import, vitest, react. Type-aware rules come from
  `oxlint-tsgolint`, which applies the TypeScript 7 tsconfig rules (no `baseUrl`; `paths` entries start with `./`).
- **Oxfmt** (`.oxfmtrc.json`): 100 columns, single quotes, semicolons. Skipped: Markdown, JSON, YAML, HTML, SQL,
  `docs/`, build output and editor folders.

## Versions to keep aligned

TypeScript 6.x (not 7), `@types/node` 26, Vitest 5, and wherever a repo uses them: Vite 8, React 19, Playwright
1.64, zod 4, Tailwind 4, tsx 4, turbo 2. The ranges are pinned in `scripts/stack-shared.json` (`toolchain` is
required, `optionalToolchain` is checked where declared); bumps happen once in `fleet-stack` and are synced (the
`bump-deps` sweep, monthly), not through per-package pull requests.

## CI and Dependabot

- One workflow (`.github/workflows/ci.yml`), identical in every repo of the profile: install, `test`, `check`,
  `ci:prebuild`, `build`, `ci:postbuild`, `ci:e2e`. It runs on pull requests and on pushes to `main`/`master` only,
  cancels superseded runs, has a 20 minute timeout, uses `node-version-file: .node-version`, the pnpm store cache and
  `pnpm install --frozen-lockfile`. `ci:e2e` is skipped for dependency-bot PRs.
- Jobs that need services (integration tests against a database, image builds, deploys) live in their own
  workflow files, which the repo owns; they follow the same rules (SHA-pinned actions at the latest major,
  `on:` limited to pull requests and pushes to the default branch, concurrency, `timeout-minutes` on every job).
- Dependabot only updates `github-actions` (monthly, one grouped PR). npm version updates are off; security updates
  stay on as a repository setting.

## Shared files and drift

`scripts/stack-shared.json` is generated by the sync. It records the profile, the shared files with their
SHA-256, the `pnpm-workspace.yaml` safety-policy keys and the standard `package.json` fields. `pnpm check:stack`
fails on any difference, in the root package and in every workspace package, so a local edit cannot slip into one
repo. `pnpm-workspace.yaml` itself is not a shared file; only its policy keys are checked.

Shared files here: `.editorconfig`, `.gitattributes`, `.node-version`, `.github/dependabot.yml` and
`scripts/check-stack.mjs` (the base, identical in every profile), plus `.oxfmtrc.json`, `.oxlintrc.json`,
`.github/workflows/ci.yml` and `docs/stack.md` (the node profile).

### Changing the standard

1. Make the change in `fleet-stack` (`base/` for every profile, `profiles/node/` for this one; versions and
   standard scripts are in `profiles/node/profile.json`), and commit it there.
2. `node sync.mjs node <repo> [<repo> ...]` from `fleet-stack`. In each repo: `pnpm install`, `pnpm run check`,
   the tests, one commit.

Never edit a shared file inside a repo. If a repo truly needs something different, the standard changes for everyone.

### Declared exceptions

The one way a repo may differ: a toolchain **version** held back while a dependency of its own cannot follow the
standard yet, declared in the `package.json` that holds it, with a reason and an expiry date:

```json
"stackExceptions": {
  "vitest": { "range": "^4.1.10", "reason": "why it cannot follow yet", "expires": "2027-01-31" }
}
```

`check:stack` and the sync honour it until the date passes; then the check fails and the exception is re-examined.
Shared files cannot be excepted. Keep exceptions rare.
