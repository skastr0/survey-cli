# survey-cli

`survey` is a consolidated, JSON-first researcher toolkit CLI. One Effect v4
binary exposing six research providers — **Exa, Firecrawl, Parallel, Keenable,
LlamaCloud, TinyFish** — two local document tools (**anydoc, pdf-inspector**),
and unified cross-provider commands that fan out, fall back, route, and fuse
results into a shared run registry, source ledger, and searchable local corpus.
Every command is also an MCP tool (`survey mcp serve`).

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
survey tinyfish agent run '{"url": "https://example.com", "goal": "..."}'
survey anydoc convert '{"path": "./report.docx"}'        # local: no key, no network
survey pdf-inspector classify '{"path": "./paper.pdf"}'   # local: text-based vs scanned
```

**Unified capabilities** — the reason this CLI exists:

```bash
survey search '{"query": "...", "tier": "free"}'        # fan out, dedupe by canonical URL, reciprocal-rank fusion
survey compare '{"query": "..."}'                       # same fan-out, per-provider lists + overlap + consensus
survey fetch '{"url": "..."}'                           # firecrawl → tinyfish → keenable → exa → parallel; stored in the corpus
survey papers '{"query": "...", "question": "..."}'     # paper index search + full-text passages (keyless)
survey extract '{"urls": [...], "schema": {...}}'       # file→llama, urls+schema→firecrawl, objective→parallel
survey convert '{"path": "./paper.pdf"}'                # local-first document → Markdown (see Local tools)
survey research '{"query": "...", "depth": "deep"}'     # multi-provider agents + citation intersection
survey verify '{"claim": "..."}'                        # cross-provider claim checking
survey monitor create '{...}'                           # normalized monitors (Parallel, TinyFish)
survey watch '{"urls": ["..."]}'                        # free DIY monitoring: re-fetch, hash, diff
survey sql '{"query": "SELECT ...", "local": true}'     # keenable SELECT or local store.db
survey runs list / inspect / wait / cancel / events     # one orbit over all provider jobs
survey sources list / dedupe / show                     # the source ledger
survey corpus search / grep / read / diff / ...         # everything survey has read, BM25-indexed
survey pipe '{"steps": [...]}'                          # compose any commands in one call
survey mcp serve                                        # every command as an MCP tool over stdio
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

## Agent composability

**Corpus.** Every page `fetch` reads (and every document `corpus add` ingests) lands in
`store.db` with an SQLite FTS5 index and full version history. Agents work it like a
codebase instead of re-fetching into context:

```bash
survey fetch '{"url": "https://docs.example.com/limits", "max_age_ms": 86400000}'  # cached for a day
survey corpus search '{"query": "rate limit", "domain": "example.com"}'   # BM25 hits + matching line numbers
survey corpus grep '{"pattern": "\\$\\d+/mo", "regex": true, "context": 1}'
survey corpus read '{"id": 12, "lines": "40-120"}'
survey corpus diff '{"url": "https://example.com/pricing"}'             # what changed since last fetch
survey sql '{"query": "SELECT domain, COUNT(*) FROM documents GROUP BY 1", "local": true}'
```

**Watch.** `survey watch` re-fetches explicit URLs plus every corpus document tagged
`watch`, and reports `new` / `changed` (with line diffs) / `unchanged` / `failed`. Run it
from cron or an agent loop; with `"providers": ["keenable"]` it costs nothing.

**Pipe.** One call, many commands. Steps run as subprocesses of the binary (identical
validation and side effects); later steps reference earlier envelopes with
`$.<step>.data…` paths (`[n]`, `[*]`, `[a:b]`), `{{ }}` templates, `foreach` fan-out over
`$item`/`$index`, `if`, `select`, `on_error`, `timeout_ms`, and a shaped `output`:

```bash
survey pipe '{
  "vars": {"topic": "effect-ts schema decoding"},
  "steps": [
    {"id": "s", "command": "search", "input": {"query": "$.vars.topic"}, "select": "$.data.results[0:5]"},
    {"id": "f", "command": "fetch", "foreach": "$.s.data", "input": {"url": "$item.url"}, "concurrency": 3},
    {"id": "hits", "command": "corpus search", "input": {"query": "decodeUnknown"}}
  ],
  "output": {"read": "$.f.data[*].url", "where": "$.hits.data.hits[*].lines"}
}'
```

**MCP.** `survey mcp serve` exposes every registered command as a tool (input schemas from
the same contracts as `survey schema show`, read-only/destructive/open-world annotations;
`auth set` excluded by default). Filter with globs: `survey mcp serve '{"include": ["search",
"fetch", "corpus *", "pipe"]}'`. Get a ready-made client config with
`survey mcp config '{"client": "claude-code"}'` (also `codex`, `opencode`, `cursor`).

## Contract

- Domain payloads are single JSON objects: inline, `@file`, `-`, or `@-`.
- stdout: `{ "ok": true, "command": "...", "data": {...} }` — always.
- stderr: `{ "ok": false, "command": "...", "error": { "type", "message", "details" } }` — always, including unparseable argv (`CliUsageError`). `details` always has `retryable` and `hint`, plus `next_step` when there is a concrete recovery call and `issues[{path, message}]` for schema mismatches.
- Exit codes: `0` success, `1` failure (including a batch with any failed item, whose full results are still on stdout).
- Flags are execution controls only (`--output`, `--concurrency`, `--timeout`, `--wait`, `--idempotency-key`), and they are per command: `survey capabilities` lists each command's flags, and every `--help` ends with a CONTRACT section.
- State lives in `~/.config/survey` (`SURVEY_HOME` to override): `auth.json`, `store.db` (runs, sources, corpus), `artifacts/`, `tools/`.
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
| TinyFish | `TINYFISH_API_KEY` | free search/fetch allowance still needs a key; `TINYFISH_{SEARCH,FETCH,BROWSER}_API_BASE_URL` |

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
bun run smoke      # end-to-end against src (or: bun scripts/smoke.ts dist/survey-darwin-arm64 --live)
bun run bump       # patch-bump every pinned version (or: bun scripts/bump.ts minor|1.2.3)
```

See `AGENTS.md` for the Effect v4 conventions, `CONTRIBUTING.md` for the command checklist, `docs/publishing.md` for releases, and `docs/porting.md` for the
provider port contract.
