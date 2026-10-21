---
name: survey
description: Multi-provider web, paper, and document research with the `survey` CLI (or its MCP tools) — fan-out search with corroboration, fetch with fallback, keyless free tier, local PDF/Office conversion, a persistent BM25 corpus you grep instead of re-fetching, page-change watching, and one-call pipelines. Use whenever a task needs more than one web lookup, needs sources that agree, reads papers or documents, or should remember what was read.
---

# survey

One JSON-in/JSON-out binary over Exa, Firecrawl, Parallel, Keenable, LlamaCloud,
TinyFish, plus local anydoc/pdf-inspector. Every command takes one JSON object
(inline, `@file`, or `-` for stdin) and prints `{ok:true, command, data}` on stdout
or `{ok:false, command, error:{type, message, details}}` on stderr.

Never guess a payload: `survey schema show "<command>"` and `survey examples show
"<command>"` are authoritative. `survey doctor` shows which providers are usable
right now (keyed / public / local / unavailable).

## Pick the command

| Need | Command |
|---|---|
| Find sources, want agreement signal | `search` — results carry `providers[]`, per-provider `ranks`, `fusion_score` (weighted RRF: Keenable counts 1.5x, override with `weights`); `read_top: n` also reads the top n into the corpus |
| Judge which provider is best for a query | `compare` |
| Read one URL | `fetch` (stores into the corpus; `max_age_ms` reuses a fresh copy) |
| Papers (arXiv, PubMed, bioRxiv, medRxiv) | `papers` — canonical `arxiv:`/`pmid:`/`doi:` ids, passage reads with `question` |
| PDF / DOCX / PPTX / XLSX / EPUB → Markdown | `convert` (local first; scanned PDFs escalate to LlamaCloud or report `needs_ocr`) |
| Structured extraction | `extract` |
| Long multi-source report | `research start` → `research check` / `wait` (non-blocking); `research` blocks. Reports land in the corpus |
| Check a claim | `verify` — confidence counts `independent_sources` (same page/domain/syndicated copy = one source) |
| Re-read / search what was already fetched | `corpus search` → `corpus read {id, lines}`; `corpus grep` |
| Detect page changes | `watch` (tag-based watch list, line diffs) or `corpus diff` |
| Follow links from a page you read | `corpus links {"id": 7, "new_only": true}` → `urls[]` for `pipe` foreach |
| Curate / hand off a corpus | `corpus tag`, `corpus export {"format": "bundle"}` → `corpus import`, `corpus prune` (dry run by default) |
| Several steps in one call | `pipe` (exit 1 when any step failed; per-step `ok`) |
| Ad-hoc questions over the ledger | `sql {"local": true, "query": "SELECT … FROM documents | sources | runs"}` |

## Cost discipline

- `"tier": "free"` on unified commands restricts routing to keyless/local access
  (Keenable public, Firecrawl keyless incl. the Research Index, hosted free tiers,
  local tools) — it never spends credits.
- Prefer `corpus search`/`grep`/`read` over re-fetching; prefer `fetch` with
  `max_age_ms` over a fresh fetch.
- `research` and provider agents are the expensive calls; start with `search` +
  `fetch`, escalate only when breadth is needed.

## Work the corpus like a codebase

```bash
survey corpus search '{"query": "rate limit", "domain": "example.com"}'   # hits[].lines = where to read
survey corpus read '{"id": 7, "lines": "120-180"}'
survey corpus grep '{"pattern": "deprecated", "ignore_case": true, "context": 2}'
survey corpus add '{"path": "./notes/interview.md", "tags": ["interviews"]}'
```

## Compose with pipe

Steps reference earlier envelopes: `$.<id>.data.path[0]`, `[*]`, `[a:b]`, `$item`,
`$index`, `{{ templates }}`; `foreach` + `concurrency`, `if`, `select`, `on_error`.

```json
{
  "steps": [
    {"id": "s", "command": "search", "input": {"query": "bun sqlite fts5", "tier": "free"}, "select": "$.data.results[0:5]"},
    {"id": "f", "command": "fetch", "foreach": "$.s.data", "input": {"url": "$item.url", "max_age_ms": 86400000}},
    {"id": "g", "command": "corpus grep", "input": {"pattern": "fts5", "ignore_case": true}}
  ],
  "output": "$.g.data.matches[0:10]"
}
```

## MCP

`survey mcp serve` mounts every command as a tool (`corpus search` → `corpus_search`).
`survey mcp config '{"client": "claude-code"}'` prints the install snippet; pass
`include`/`exclude` globs to expose a subset; `timeout_ms` caps each tool call (default 10 min,
then a retryable `TimeoutError`).

## Reading results

- Batch commands return `{outcome, total, success_count, error_count, results[]}`;
  exit code 1 when any item failed — read per-item `ok`.
- Large outputs may be written to an artifact file (`--output inline` forces inline).
- Errors carry `details.retryable`; retry only when it is true.
