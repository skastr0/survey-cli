# Security Policy

## Supported Status

survey-cli is experimental and solo-maintained. Only the latest published
version of `@skastr0/survey` receives fixes. Reports are reviewed on a
best-effort basis, without a formal response SLA.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
through GitHub private vulnerability reporting on
[skastr0/survey-cli](https://github.com/skastr0/survey-cli/security/advisories/new),
or contact the maintainer directly if that is unavailable.

Include:

- affected version (`survey --version`) or commit
- reproduction steps, with the exact command and JSON payload
- impact
- relevant envelopes or logs

Redact API keys, `auth.json` contents, personal data, private URLs, and
unrelated secrets from reports.

## How survey Handles Secrets

- Provider keys come from environment variables first, then
  `~/.config/survey/auth.json` (`SURVEY_HOME` overrides the root). The auth
  file is written with mode `0600`.
- Error envelopes redact any `details` field whose key looks like a
  credential (`api_key`, `authorization`, `token`, `secret`, `password`,
  `cookie`, `credential`) before printing provider error bodies.
- Runtime data (store, corpus, artifacts, idempotency receipts, local tools)
  lives under the survey home, never in the working directory.
- `survey mcp serve` excludes `auth set` from the exposed tools by default.
  Include it explicitly only for a client you trust with your keys.
- Fetched pages and documents are stored in the local corpus. Treat
  `store.db` and `artifacts/` as containing whatever you fetched.

## Scope

In scope: the `survey` binary, the npm wrapper and platform packages, the
MCP server, local tool installation, and documented workflows in this
repository.

Out of scope: the provider APIs themselves (Exa, Firecrawl, Parallel,
Keenable, LlamaCloud, TinyFish), content returned by those providers or by
fetched pages, user-provided credentials, and machine configuration outside
this repository, unless survey directly mishandles them.

## Supply Chain

Official distribution is npm only: `@skastr0/survey` plus
`@skastr0/survey-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`, published
from GitHub Actions with npm trusted publishing and provenance. Do not trust
binaries or packages from other sources that claim to be survey.
