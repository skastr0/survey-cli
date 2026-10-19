import { Schema } from "effect"

/** Routing domain for research/verify: academic consults the paper index. */
export const Domain = Schema.Literals(["auto", "web", "academic"]).annotate({
  description:
    "academic: also consult the Firecrawl Research Index (keyless). auto (default): academic when the text looks like a literature question. web: never.",
})
export type Domain = typeof Domain.Type

const ACADEMIC_HINT =
  /\b(papers?|arxiv|preprints?|stud(y|ies)|literature|peer[- ]reviewed|journals?|doi|pubmed|meta-analys[ie]s|systematic review|clinical trials?|benchmarks?|citations?|state of the art|sota|dataset)\b/i

/** Whether `domain` (default auto) routes `text` to the paper index. */
export const wantsPapers = (domain: Domain | undefined, text: string) =>
  domain === "academic" || ((domain ?? "auto") === "auto" && ACADEMIC_HINT.test(text))
