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
survey anydoc convert '{"path": "./report.docx"}'        # local: no key, no network
survey pdf-inspector classify '{"path": "./paper.pdf"}'   # local: text-based vs scanned
```

**Unified capabilities** — the reason this CLI exists:

```bash
survey search '{"query": "..."}'                        # fan out exa+parallel+keenable, dedupe by canonical URL
survey fetch '{"url": "..."}'                           # firecrawl → keenable → exa fallback chain
survey extract '{"urls": [...], "schema": {...}}'       # file→llama, urls+schema→firecrawl, objective→parallel
survey convert '{"path": "./paper.pdf"}'                # local-first document → Markdown (see Local tools)
survey research '{"query": "...", "depth": "deep"}'     # multi-provider agents + citation intersection
survey verify '{"claim": "..."}'                        # cross-provider claim checking
survey monitor create '{...}'                           # normalized monitors (Parallel GA)
survey sql '{"query": "SELECT ...", "local": true}'     # keenable SELECT or local store.db
survey runs list / inspect / wait / cancel / events     # one orbit over all provider jobs
survey sources list / dedupe / show                     # the source ledger
```

## Local tools (anydoc, pdf-inspector)

`survey anydoc …` and `survey pdf-inspector …` wrap Firecrawl's open-source Rust libraries
(`@firecrawl/anydoc`, `@firecrawl/pdf-inspector`). They need no API key and make no network
calls (a document `url` is downloaded, then converted locally). They are optional installs
because each native module is 7-12 MB per platform:

```bash
mkdir -p ~/.config/survey/tools && bun add --cwd ~/.config/survey/tools @firecrawl/anydoc @firecrawl/pdf-inspector
survey doctor    # local_tools[]: mode = node_module | path_cli | unavailable, plus version and operations
```

Resolution order per tool: the npm module (in `$SURVEY_LOCAL_TOOLS_DIR` or `~/.config/survey/tools`, the
current directory, bun's global dir, or beside a PATH CLI) → the `anydoc` / `pdf-inspector` CLI on PATH
(convert / classify / extract only) → a typed `LocalToolUnavailableError` with an install hint.
`@firecrawl/pdf-inspector` publishes no darwin-x64 build.

`survey convert` (and `survey extract` with a file or document URL and no schema/prompt) routes
local-first and always reports `route.selected`, `route.reason` and `route.trace`:

- PDF → `pdf-inspector` classify → text-based: extract locally; scanned/image/mixed or garbled fonts:
  LlamaCloud parse when `LLAMA_CLOUD_API_KEY` is set, else `status: "needs_ocr"` with the classification.
- Office/CSV/EPUB/RTF/ODF → `anydoc`.
- `"route": "local"` forbids any hosted call; `"route": "llama"` skips the local tools.

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
| Exa | `EXA_API_KEY` | |
| Firecrawl | `FIRECRAWL_API_KEY` | |
| Parallel | `PARALLEL_API_KEY` | |
| Keenable | `KEENABLE_API_KEY` | public fallback without a key; `KEENABLE_TITLE` for title header |
| LlamaCloud | `LLAMA_CLOUD_API_KEY` | |

Every provider gets `*_API_BASE_URL` overrides for tests/mocks.

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
