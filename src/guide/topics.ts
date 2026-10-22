/**
 * The agent playbook embedded in the binary. `survey guide` serves it, and
 * `skills/survey/SKILL.md` is rendered from it (test/guide.test.ts fails on
 * drift), so the CLI is the single source an agent learns from.
 *
 * Each topic lists command globs; `survey guide {topic}` attaches the live
 * contracts (description, output, first example) for those commands.
 */

export interface GuideTopic {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly commands: ReadonlyArray<string>
  readonly body: string
}

export const SKILL_DESCRIPTION =
  "Multi-provider web, paper, and document research with the `survey` CLI (or its MCP tools) — fan-out search with corroboration, fetch with fallback, keyless free tier, local PDF/Office conversion, a persistent BM25 corpus you grep instead of re-fetching, page-change watching, and one-call pipelines. Use whenever a task needs more than one web lookup, needs sources that agree, reads papers or documents, or should remember what was read."

export const OVERVIEW = `One JSON-in/JSON-out binary over Keenable, Exa, Parallel, Firecrawl, TinyFish,
LlamaCloud, plus local anydoc/pdf-inspector. Every command takes one JSON object
(inline, \`@file\`, or \`-\` for stdin) and prints \`{ok:true, command, data}\` on stdout
or \`{ok:false, command, error:{type, message, details}}\` on stderr.

Never guess a payload: \`survey schema show "<command>"\` and \`survey examples show
"<command>"\` are authoritative. \`survey doctor\` shows which providers are usable
right now (keyed / public / local / unavailable). \`survey guide '{"topic":"<id>"}'\`
explains one area with the live contracts of its commands.`

export const TOPICS: ReadonlyArray<GuideTopic> = [
  {
    id: "choose",
    title: "Pick the command",
    summary: "Which command answers which need.",
    commands: ["search", "compare", "fetch", "papers", "convert", "extract", "verify", "watch", "sql"],
    body: `| Need | Command |
|---|---|
| Find sources, want agreement signal | \`search\` — results carry \`providers[]\`, per-provider \`ranks\`, \`fusion_score\` (weighted RRF: Keenable counts 1.5x, override with \`weights\`); \`read_top: n\` also reads the top n into the corpus |
| Judge which provider is best for a query | \`compare\` |
| Read one URL | \`fetch\` (keenable → firecrawl → tinyfish → exa → parallel; stores into the corpus; \`max_age_ms\` reuses a fresh copy) |
| Papers (arXiv, PubMed, bioRxiv, medRxiv) | \`papers\` — canonical \`arxiv:\`/\`pmid:\`/\`doi:\` ids, passage reads with \`question\` |
| PDF / DOCX / PPTX / XLSX / EPUB → Markdown | \`convert\` (local first; scanned PDFs escalate to LlamaCloud or report \`needs_ocr\`) |
| Structured extraction | \`extract\` |
| Long multi-source report | \`research start\` → \`research check\` / \`wait\` (non-blocking); \`research\` blocks. Reports land in the corpus |
| Check a claim | \`verify\` — confidence counts \`independent_sources\` (same page/domain/syndicated copy = one source) |
| Re-read / search what was already fetched | \`corpus search\` → \`corpus read {id, lines}\`; \`corpus grep\` |
| Detect page changes | \`watch\` (tag-based watch list, line diffs) or \`corpus diff\` |
| Follow links from a page you read | \`corpus links {"id": 7, "new_only": true}\` → \`urls[]\` for \`pipe\` foreach |
| Curate / hand off a corpus | \`corpus tag\`, \`corpus export {"format": "bundle"}\` → \`corpus import\`, \`corpus prune\` (dry run by default) |
| Several steps in one call | \`pipe\` (exit 1 when any step failed; per-step \`ok\`) |
| Ad-hoc questions over the ledger | \`sql {"local": true, "query": "SELECT … FROM documents | sources | runs"}\` |`,
  },
  {
    id: "cost",
    title: "Cost discipline",
    summary: "Free tier, keys, and which calls are expensive.",
    commands: ["auth set"],
    body: `- \`"tier": "free"\` on unified commands restricts routing to keyless/local access
  (Keenable public, Firecrawl keyless incl. the Research Index, hosted free tiers,
  local tools) — it never spends credits.
- Keys come from env vars or \`survey auth set '{"provider":"exa","api_key":"…"}'\`
  (\`auth.json\`, mode 0600); \`survey auth status\` never prints them. A provider
  without a key is skipped, not fatal (TinyFish needs a free account key).
- Prefer \`corpus search\`/\`grep\`/\`read\` over re-fetching; prefer \`fetch\` with
  \`max_age_ms\` over a fresh fetch.
- \`research\` and provider agents are the expensive calls; start with \`search\` +
  \`fetch\`, escalate only when breadth is needed.`,
  },
  {
    id: "corpus",
    title: "Work the corpus like a codebase",
    summary: "Everything survey reads is versioned and BM25-indexed locally.",
    commands: ["corpus *"],
    body: `\`\`\`bash
survey corpus search '{"query": "rate limit", "domain": "example.com"}'   # hits[].lines = where to read
survey corpus read '{"id": 7, "lines": "120-180"}'
survey corpus grep '{"pattern": "deprecated", "ignore_case": true, "context": 2}'
survey corpus add '{"path": "./notes/interview.md", "tags": ["interviews"]}'
\`\`\``,
  },
  {
    id: "pipe",
    title: "Compose with pipe",
    summary: "Several commands in one call, wired by JSONPath references.",
    commands: ["pipe"],
    body: `Steps reference earlier envelopes: \`$.<id>.data.path[0]\`, \`[*]\`, \`[a:b]\`, \`$item\`,
\`$index\`, \`{{ templates }}\`; \`foreach\` + \`concurrency\`, \`if\`, \`select\`, \`on_error\`.

\`\`\`json
{
  "steps": [
    {"id": "s", "command": "search", "input": {"query": "bun sqlite fts5", "tier": "free"}, "select": "$.data.results[0:5]"},
    {"id": "f", "command": "fetch", "foreach": "$.s.data", "input": {"url": "$item.url", "max_age_ms": 86400000}},
    {"id": "g", "command": "corpus grep", "input": {"pattern": "fts5", "ignore_case": true}}
  ],
  "output": "$.g.data.matches[0:10]"
}
\`\`\``,
  },
  {
    id: "research",
    title: "Research, verify, papers",
    summary: "Multi-provider reports, claim checks, and academic sources.",
    commands: ["research*", "verify", "papers"],
    body: `- \`research start {query}\` returns a \`research_id\` at once; poll \`research check\`
  or block on \`research wait\`. The fused report is stored in the corpus.
- \`verify {claim}\` asks several providers and groups citations into independent
  sources; \`confidence\` comes from independent groups, not raw citation counts.
- \`domain: "academic"\` (or \`auto\`) adds the paper index; \`papers {query, question}\`
  returns passages from full text.`,
  },
  {
    id: "mcp",
    title: "MCP",
    summary: "Mount every command as an MCP tool.",
    commands: ["mcp *"],
    body: `\`survey mcp serve\` mounts every command as a tool (\`corpus search\` → \`corpus_search\`).
\`survey mcp config '{"client": "claude-code"}'\` prints the install snippet; pass
\`include\`/\`exclude\` globs to expose a subset; \`timeout_ms\` caps each tool call (default 10 min,
then a retryable \`TimeoutError\`).`,
  },
  {
    id: "scripting",
    title: "Script it",
    summary: "Shell patterns: stdin, files, jq, exit codes, artifacts.",
    commands: [],
    body: `\`\`\`bash
survey search '{"query":"…"}' | jq -r '.data.results[].url'          # data is always under .data
jq -n --arg q "$QUERY" '{query:$q, tier:"free"}' | survey search -  # build payloads safely
survey corpus add @payload.json                                     # @file input
survey search '{"query":"…"}' 2> err.json || jq .error err.json     # failures: stderr + exit 1
\`\`\`

- Exit 0 = success; exit 1 = failure (or any failed batch item / pipe step).
- Outputs over 64 KB become an artifact pointer; \`--output inline\` forces inline.
- \`survey capabilities '{"command":"corpus *"}'\` lists commands, flags, and input modes.`,
  },
  {
    id: "results",
    title: "Reading results",
    summary: "Envelopes, batches, artifacts, and retryable errors.",
    commands: [],
    body: `- Batch commands return \`{outcome, total, success_count, error_count, results[]}\`;
  exit code 1 when any item failed — read per-item \`ok\`.
- Large outputs may be written to an artifact file (\`--output inline\` forces inline).
- Errors carry \`details.retryable\`; retry only when it is true. \`details.next_step\`
  names the recovery call when there is one.`,
  },
]

export const topicIds = TOPICS.map((topic) => topic.id)

/** The full playbook as a SKILL.md for harnesses that load skills from disk. */
export const renderSkill = () =>
  [
    "---",
    "name: survey",
    `description: ${SKILL_DESCRIPTION}`,
    "---",
    "",
    "# survey",
    "",
    OVERVIEW,
    "",
    ...TOPICS.flatMap((topic) => [`## ${topic.title}`, "", topic.body, ""]),
  ].join("\n")
