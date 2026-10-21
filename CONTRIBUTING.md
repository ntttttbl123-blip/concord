# Contributing to Concord

Thanks for looking. Concord reconciles tokenized securities on Stellar against the official
register. Before you start, read the [README](./README.md) for what it does and its stated limits,
and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for how the code is laid out.

## Set up

Needs Node 24+ (storage uses `node:sqlite`) and pnpm 10.22, the version pinned in the
`packageManager` field of `package.json`. `corepack enable` installs that version. If it cannot
write to your Node bin directory, run `corepack enable --install-directory <dir>` and put `<dir>`
on your `PATH`. Without the pinned version, `pnpm` will not find the workspace scripts.

```sh
pnpm install
pnpm build        # builds packages/core first; the API and the dashboard import its output
pnpm test         # unit and service tests, no network needed
pnpm typecheck
pnpm dev          # API and dashboard with reload, http://127.0.0.1:4400
```

`pnpm build` must have run at least once before `pnpm test` or `pnpm typecheck` in
`services/api`, because that package imports `@concord/core` from its `dist/` folder. After you
change `packages/core`, rebuild it.

CI runs the tests a second time in a random order, so tests that depend on each other fail
there. The seed is the workflow run id and appears in the log as `Running tests with seed "..."`.
To replay a failing run, take that seed and run

```sh
pnpm test --sequence.shuffle --sequence.seed=<seed>
```

Everything is optional to configure. See [`.env.example`](./.env.example) if you want to point
at your own RPC provider.

## Where changes go

| You are changing | Look in | Tests |
|---|---|---|
| How holdings, breaks, entitlements or controls are computed | `packages/core/src` | `packages/core/test/core.test.ts` |
| Reading the ledger (RPC events, Horizon opening balances) | `services/api/src/chain.ts` | `services/api/test` |
| Workspaces, sign-in, sessions, rate limits | `services/api/src/{auth,auth-api,tenants,security}.ts` | `services/api/test/tenancy.test.ts` |
| HTTP routes, CLI, orchestration | `services/api/src/{api,cli,concord}.ts` | `services/api/test/service.test.ts` |
| Database tables | `services/api/src/schema.ts` | add a migration, see below |
| The dashboard | `apps/web/src` | none yet; check it in a browser |

### Where the tests live

- `packages/core/test/core.test.ts` covers the accounting rules: amount parsing, CSV reading,
  replay of ledger events, position and movement reconciliation, corporate actions and the
  controls log. It runs on fixtures only.
- `services/api/test/service.test.ts` covers the HTTP routes, the CLI and the orchestration, using
  `FakeChain` in place of the ledger.
- `services/api/test/tenancy.test.ts` covers workspaces, sign-in, sessions and rate limits.
- `services/api/test/helpers.ts` holds the shared fakes (`FakeChain`, `memoryStore`). Add new
  fakes there rather than copying them into a test file.

## Rules that are easy to break

- **`packages/core` does no I/O.** No file, network, clock or database access. It takes events and
  rows in and returns results. That is what keeps it testable and keeps the accounting auditable.
- **Money is `bigint` in the smallest unit.** Never use floating point for an amount. Parsing
  rejects excess precision rather than rounding it, on purpose: a register with more precision
  than the chain can hold is itself a break.
- **Migrations are append-only.** `schema.ts` lists migrations in order, and a database's
  `user_version` is how many have run. Add to the end of the list. Never edit an entry that has
  shipped.
- **No sample data in the product.** A new workspace is empty. The chain side comes from the
  ledger and the register side from an uploaded file. Do not add seeded or invented records to
  anything a user can reach. The testnet practice asset in `services/api/src/demo` is a
  development tool and says so.
- **Read-only by design.** Concord never holds keys and never submits transactions that move
  value. Changes that would add that are a product decision; open an issue first.
- **Tests do not touch the network.** Use `FakeChain` from `services/api/test/helpers.ts`, and
  `memoryStore` from `services/api/src/tenants.ts`, which `helpers.ts` imports.

## Making a change

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Branch from `main`. Keep one concern per pull request.
3. Add or update tests with the change. A bug fix should come with a test that fails without it.
4. Run `pnpm build && pnpm test && pnpm typecheck` before you push. CI runs the same.
5. Open the pull request and fill in the template. Link the issue it closes.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). Use one of
these scopes, which match the packages and apps in the repository:

- `core`: `packages/core`
- `api`: `services/api`
- `web`: `apps/web`

Types in use are `feat`, `fix`, `docs`, `build`, `test` and `chore`. Examples:
`fix(core): ...`, `feat(api): ...`, `feat(web): ...`, `test(api): ...`. `docs:`, `build:` and
`chore:` take no scope when they cover the whole repository. Keep the subject short and say why in
the body when it is not obvious.

If the change is user-visible or touches a schema (`CONTROL_MIGRATIONS` or `ORG_MIGRATIONS` in
`services/api/src/schema.ts`), add a line to the `Unreleased` section of
[`CHANGELOG.md`](./CHANGELOG.md) in the same pull request; that file says how commit types map
to sections. Internal refactorings and docs-only changes need no entry.

## Adding a break type

Search for an existing type, such as `STATUS_MISMATCH`, to find every place that has to change.
In outline: add the name to the union in `packages/core/src/reconcile.ts`, produce it in
`reconcilePositions`, cover it in `core.test.ts`, then add its label in the dashboard's breaks
view (`apps/web/src/breaks.tsx`). Movement and distribution breaks follow the same pattern in
`movements.ts` and `distributions.ts`.

## Reporting problems

- Bugs and feature ideas: use the issue templates.
- Security issues: do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

By taking part you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). By contributing
you agree that your contribution is licensed under the [MIT license](./LICENSE).


## CI checks

Every pull request runs the `CI` workflow on a matrix. All three jobs must be green before merging:

- `check (ubuntu-latest, node 24.11)` runs on the pinned Node 24 minor
- `check (ubuntu-latest, node 24.x)` runs on the latest Node 24
- `check (macos-latest, node 24.x)` runs on macOS, to catch `node:sqlite` differences

Each job has a 15 minute timeout, so a stuck run fails instead of hanging.

Coverage, the accessibility checks and the browser smoke test run only on the
`ubuntu-latest` / Node 24.x job, because they upload artifacts and need a browser.
