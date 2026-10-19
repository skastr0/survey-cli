# survey-cli

`survey` is a consolidated, JSON-first researcher toolkit CLI. One Effect v4
binary exposing five research providers — **Exa, Firecrawl, Parallel, Keenable,
LlamaCloud** — plus unified cross-provider commands that fan out, fall back,
route, and fuse results into a shared run registry and source ledger.

## Install

```bash
# from source
bun install && bun run build && bun run install:local   # → ~/.local/bin/survey

# from npm (platform binaries, no Bun needed at runtime)
npm i -g @skastr0/survey
```

## The two layers

**Provider namespaces** — every provider operation, verbatim payloads:

```bash
survey exa web-search '{"query": "effect v4", "numResults": 5}'
survey exa agent start '{"query": "...", "effort": "high"}'
survey firecrawl scrape '{"url": "https://example.com", "formats": ["markdown"]}'
survey parallel deep-research start '{"input": "..."}'
survey keenable select '{"query": "SELECT ..."}'
survey llama parse create '{"file_path": "./paper.pdf"}'
```

**Unified capabilities** — the reason this CLI exists:

```bash
survey search '{"query": "..."}'                        # fan out exa+parallel+keenable, dedupe by canonical URL
survey fetch '{"url": "..."}'                           # firecrawl → keenable → exa → parallel fallback chain
survey papers '{"query": "...", "question": "..."}'     # paper index search + full-text passages (keyless)
survey extract '{"urls": [...], "schema": {...}}'       # file→llama, urls+schema→firecrawl, objective→parallel
survey research '{"query": "...", "depth": "deep"}'     # multi-provider agents + citation intersection
survey verify '{"claim": "..."}'                        # cross-provider claim checking
survey monitor create '{...}'                           # normalized monitors (Parallel GA)
survey sql '{"query": "SELECT ...", "local": true}'     # keenable SELECT or local store.db
survey runs list / inspect / wait / cancel / events     # one orbit over all provider jobs
survey sources list / dedupe / show                     # the source ledger
```

## Contract

- Domain payloads are single JSON objects: inline, `@file`, `-`, or `@-`.
- stdout: `{ "ok": true, "command": "...", "data": {...} }` — always.
- stderr: `{ "ok": false, "command": "...", "error": {...} }` — always.
- Flags are execution controls only: `--output`, `--concurrency`, `--timeout`, `--wait`.
- State lives in `~/.config/survey` (`SURVEY_HOME` to override): `auth.json`, `store.db`, `artifacts/`.
- Partial provider failure never discards success — results carry `providers[]` provenance and a `failures[]` array.

## Auth

Env vars win; `~/.config/survey/auth.json` is the fallback (`survey auth set`).

| Provider | Env var | Notes |
|---|---|---|
| Exa | `EXA_API_KEY` | keyless web-search/contents via hosted MCP (`EXA_MCP_URL`) |
| Firecrawl | `FIRECRAWL_API_KEY` | keyless search/scrape/parse/interact/research index (refused from VPN/proxy IPs) |
| Parallel | `PARALLEL_API_KEY` | keyless search/extract via free Search MCP (`PARALLEL_SEARCH_MCP_URL`) |
| Keenable | `KEENABLE_API_KEY` | public fallback without a key; `KEENABLE_TITLE` for title header |
| LlamaCloud | `LLAMA_CLOUD_API_KEY` | |

Every provider gets `*_API_BASE_URL` overrides for tests/mocks.

### Free / keyless tier

`src/core/tiers.ts` resolves every provider × capability to
`{ available, mode: keyed|public|local|unavailable, cost: free|paid }`;
`survey doctor` shows it live (`free_capabilities`), `survey capabilities` shows the matrix.
Keyless responses carry `auth_mode: "public"` (plus `ignored_options` when an MCP tool
cannot honor an input). Pass `"tier": "free"` to `search`, `fetch`, `research`, `verify`,
or `papers` to route only to keyless/local access — configured keys are hidden, so no
account credits are spent. `research`/`verify` take `"domain": "academic"` (or `auto`)
to consult the Firecrawl Research Index.

## Discovery

```bash
survey doctor          # env readiness matrix
survey capabilities    # protocol + provider capability matrix + command inventory
survey schema list     # commands with JSON input schemas
survey schema show "exa web-search"
survey examples list / show "search"
```

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build      # 4 platform binaries in dist/
bun run verify     # all of the above
```

See `AGENTS.md` for the Effect v4 conventions and `docs/porting.md` for the
provider port contract.
