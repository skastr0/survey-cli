#!/usr/bin/env bun
/** Render skills/survey/SKILL.md from the playbook embedded in the binary (src/guide/topics.ts). */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { renderSkill } from "../src/guide/topics"

writeFileSync(join(import.meta.dir, "..", "skills", "survey", "SKILL.md"), renderSkill())
console.log(JSON.stringify({ ok: true, wrote: "skills/survey/SKILL.md" }))
