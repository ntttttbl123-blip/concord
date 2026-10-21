# Support

Where to ask questions about Concord, what to include, and what to expect back.

## What is supported

The latest `main`. There are no tagged releases yet; when they exist, the latest tag will be
the supported line and this document will say so. If you are running an older checkout, update
and reproduce before reporting — fixes land on `main` only.

## Response targets

The same targets as [`SECURITY.md`](./SECURITY.md): we aim to acknowledge within five working
days and to say what we plan to do within ten. This is a small project, so those are targets,
not guarantees.

## Where to ask

| You have… | Go to |
|---|---|
| A bug, or behaviour that looks wrong | A [bug report issue](https://github.com/useconcord/concord/issues/new?template=bug_report.yml) |
| A feature idea | A [feature request issue](https://github.com/useconcord/concord/issues/new?template=feature_request.yml) |
| A question about running or using Concord | An issue too — GitHub Discussions is not enabled on this repository, so questions go through the issue tracker. Say it is a question in the title. |
| A security problem | **Not an issue.** Report privately via [Security → Report a vulnerability](https://github.com/useconcord/concord/security/advisories/new), as [`SECURITY.md`](./SECURITY.md) describes. |

Blank issues are off (`.github/ISSUE_TEMPLATE/config.yml`), so the templates above are the way
in. If a security problem is any part of what you found, use the private route for all of it.

## What to include

- The commit you are running (`git rev-parse HEAD`) and your Node version — Concord needs
  Node 24 or later (`package.json` `engines`).
- What you did, what you expected, and what happened instead; exact error text helps.
- For indexing or reconciliation questions: the network (mainnet or testnet) and the asset's
  code or contract id. **Never attach a real register, journal or holder data** — reproduce
  with the testnet practice asset (`pnpm demo:testnet`, see the README) or invented figures
  instead.
- For deployment questions: how it is deployed (the Dockerfile, the Render blueprint, or bare
  `pnpm start`) and the relevant `CONCORD_*` settings **with secrets removed**.

## What support is not

- Concord sends no email and holds no keys; nobody will ever ask you for credentials, seeds or
  holder data to "debug" something.
- Operating your deployment (reverse proxy, TLS, backups) is yours; the README's **Deploying**
  section and `SECURITY.md`'s operator notes are the reference.
