import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"

;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

import "../src/capabilities/corpus"
import "../src/capabilities/pipe"
import { guide } from "../src/commands/guide"
import { renderSkill, TOPICS } from "../src/guide/topics"

describe("survey guide", () => {
  it("skills/survey/SKILL.md is rendered from the embedded playbook (run `bun run gen:skill`)", () => {
    expect(readFileSync(join(__dirname, "..", "skills", "survey", "SKILL.md"), "utf8")).toBe(renderSkill())
  })

  it.effect("overview lists every topic and where to start", () =>
    Effect.gen(function* () {
      const overview = (yield* guide({})) as { topics: Array<{ id: string }>; start_here: Array<string> }
      expect(overview.topics.map((topic) => topic.id)).toEqual(TOPICS.map((topic) => topic.id))
      expect(overview.start_here[0]).toBe("survey doctor")
    }),
  )

  it.effect("a topic attaches the live contracts of its commands", () =>
    Effect.gen(function* () {
      const corpus = (yield* guide({ topic: "corpus" })) as { commands: Array<{ command: string; example: unknown }> }
      expect(corpus.commands.map((c) => c.command)).toContain("corpus grep")
      expect(corpus.commands.every((c) => c.command.startsWith("corpus "))).toBe(true)
      expect(corpus.commands.find((c) => c.command === "corpus grep")?.example).not.toBeNull()
    }),
  )

  it.effect("unknown topics are NotFoundError; format skill returns SKILL.md", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(guide({ topic: "nope" }))
      expect(missing._tag).toBe("NotFoundError")
      const skill = (yield* guide({ format: "skill" })) as { markdown: string }
      expect(skill.markdown.startsWith("---\nname: survey\n")).toBe(true)
    }),
  )
})
