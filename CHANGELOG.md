# Changelog

All notable changes to Concord are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions, once
they exist, will follow [Semantic Versioning](https://semver.org/). There are no tagged
releases yet, so everything sits under **Unreleased** until the first tag.

## How entries are made

Commit messages already follow Conventional Commits with the package as scope
(`CONTRIBUTING.md`, "Making a change"). Types map to sections like this:

| Commit type | Changelog section |
|---|---|
| `feat` | Added |
| `fix` | Fixed |
| change in behaviour of an existing feature | Changed |
| removal, or notice of one | Removed / Deprecated |
| security-relevant fix | Security |
| `docs`, `build`, `test`, `chore` | Usually omitted |

Two kinds of change are **always** listed, whatever the commit type:

- **User-visible changes** — anything a person at the dashboard, the CLI or the HTTP API can
  notice, including changed wording of errors and reports.
- **Schema changes** — any new entry in `CONTROL_MIGRATIONS` or `ORG_MIGRATIONS`
  (`services/api/src/schema.ts`). Migrations are append-only and run on open, so a schema
  entry tells an operator a deploy will touch their databases; the entry names the tables.

A `docs`-only or internal refactoring commit does not need an entry. When in doubt, write one.

## [Unreleased]

Everything to date; Concord's history begins 2026-10 with the commits below.

### Added

- CSV templates can include one illustrative example row with `?example=1` or `?example=true` (#200).
- The accounting core (`feat(core)`, `c402eae`): holdings replay from CAP-67 events, position
  and movement reconciliation with typed breaks, corporate-action entitlements (dividend,
  split, redemption), controls matching, amount parsing with exact decimal-string arithmetic.
- The API service (`feat(api)`, `5e965a5`): the RPC indexer with Horizon opening balances,
  accounts and per-workspace SQLite databases, sessions and invitations, rate limiting, the
  HTTP API and the `concord` CLI. First schemas: `CONTROL_MIGRATIONS` (users, orgs,
  memberships, sessions, invites) and `ORG_MIGRATIONS` (assets, events, registers, journals,
  instructions, runs, actions, notes).
- The dashboard (`feat(web)`, `ab20a37`): sign-in, breaks and sign-off, holdings, corporate
  actions, controls log, audit export, team management.
- Deployment (`build`, `ffce294`): Dockerfile and Render blueprint — listed because it is how
  operators run Concord.
- Workspace scaffolding, the product brief and README (`1ec94a5`, `601d473`), and the
  documentation set: workspaces/deploy/limits, license, contributing guide, security policy,
  architecture and CI (`e4f5b92`, `325ae12`).
