import { Effect, Schema } from "effect"

import { makeJsonCommand } from "../core/command"
import { listContracts, matchesCommandGlob, registerContract } from "../core/discovery"
import { NotFoundError } from "../core/errors"
import { OVERVIEW, renderSkill, SKILL_DESCRIPTION, TOPICS, topicIds } from "../guide/topics"

export const GuideInput = Schema.Struct({
  topic: Schema.optional(
    Schema.String.annotate({ description: `One of: ${topicIds.join(", ")}. Omit for the overview and topic list.` }),
  ),
  /** skill: the whole playbook as SKILL.md text, ready to save into a harness skills folder. */
  format: Schema.optional(Schema.Literals(["json", "skill"])),
})

const contractView = (globs: ReadonlyArray<string>) =>
  listContracts()
    .filter((contract) => matchesCommandGlob(contract.command, globs))
    .map((contract) => ({
      command: contract.command,
      description: contract.description,
      output: contract.output ?? null,
      example: contract.examples?.[0]?.input ?? null,
    }))

export const guide = (input: typeof GuideInput.Type) =>
  Effect.gen(function* () {
    if (input.format === "skill") {
      return { format: "skill" as const, name: "survey", description: SKILL_DESCRIPTION, markdown: renderSkill() }
    }
    if (input.topic === undefined) {
      return {
        overview: OVERVIEW,
        topics: TOPICS.map(({ id, title, summary }) => ({ id, title, summary })),
        start_here: [
          "survey doctor",
          `survey guide '{"topic":"choose"}'`,
          `survey schema show "<command>"`,
          `survey examples show "<command>"`,
        ],
      }
    }
    const topic = TOPICS.find((candidate) => candidate.id === input.topic)
    if (topic === undefined) {
      return yield* new NotFoundError({
        resource: "guide topic",
        id: input.topic,
        message: `No guide topic "${input.topic}". Topics: ${topicIds.join(", ")}`,
        next_step: "survey guide",
      })
    }
    return {
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      markdown: topic.body,
      commands: contractView(topic.commands),
    }
  })

export const guideCommand = makeJsonCommand({
  name: "guide",
  commandName: "guide",
  description:
    "Learn survey from the binary itself: overview and topics, one topic with the live contracts of its commands, or the whole playbook as SKILL.md. Input: optional {topic?, format?: json|skill}. Start here.",
  schema: GuideInput,
  optionalInput: true,
  run: guide,
})

registerContract({
  command: "guide",
  description:
    "Learn survey from the binary itself: overview and topics, one topic with the live contracts of its commands, or the whole playbook as SKILL.md. Input: optional {topic?, format?: json|skill}. Start here.",
  output:
    "no topic: { overview, topics[{ id, title, summary }], start_here[] }; {topic}: { id, title, summary, markdown, commands[{ command, description, output, example }] }; {format:\"skill\"}: { format, name, description, markdown (SKILL.md text) }",
  inputSchema: GuideInput,
  examples: [
    { name: "overview", input: {} },
    { name: "one topic", input: { topic: "pipe" } },
    { name: "save as a skill", input: { format: "skill" } },
  ],
})
