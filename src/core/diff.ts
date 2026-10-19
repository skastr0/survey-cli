/**
 * Minimal line diff for corpus version comparison. LCS over lines with a
 * size ceiling; beyond it we fall back to a set-based added/removed summary
 * so huge pages never blow up memory.
 */

export interface LineDiff {
  readonly mode: "lcs" | "set"
  readonly added: number
  readonly removed: number
  readonly unchanged: number
  readonly hunks: ReadonlyArray<{
    readonly old_start: number
    readonly new_start: number
    readonly lines: ReadonlyArray<string>
  }>
}

const MAX_CELLS = 4_000_000

export const diffLines = (before: string, after: string, context = 2): LineDiff => {
  // "" has zero lines, not one empty line.
  const a = before.length === 0 ? [] : before.split("\n")
  const b = after.length === 0 ? [] : after.split("\n")

  // Trim common prefix/suffix so the LCS table only covers the changed core.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const coreA = a.slice(start, endA)
  const coreB = b.slice(start, endB)

  if (coreA.length * coreB.length > MAX_CELLS) {
    const setA = new Set(coreA)
    const setB = new Set(coreB)
    const removed = coreA.filter((line) => !setB.has(line))
    const added = coreB.filter((line) => !setA.has(line))
    return {
      mode: "set",
      added: added.length,
      removed: removed.length,
      unchanged: a.length - removed.length,
      hunks: [
        {
          old_start: start + 1,
          new_start: start + 1,
          lines: [...removed.slice(0, 200).map((l) => `-${l}`), ...added.slice(0, 200).map((l) => `+${l}`)],
        },
      ],
    }
  }

  const n = coreA.length
  const m = coreB.length
  const table: Array<Uint32Array> = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!
    const next = table[i + 1]!
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = coreA[i] === coreB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }

  type Op = { readonly tag: " " | "-" | "+"; readonly line: string; readonly oldNo: number; readonly newNo: number }
  const ops: Array<Op> = []
  for (let k = Math.max(0, start - context); k < start; k += 1) {
    ops.push({ tag: " ", line: a[k]!, oldNo: k + 1, newNo: k + 1 })
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && coreA[i] === coreB[j]) {
      ops.push({ tag: " ", line: coreA[i]!, oldNo: start + i + 1, newNo: start + j + 1 })
      i += 1
      j += 1
    } else if (i < n && (j === m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      ops.push({ tag: "-", line: coreA[i]!, oldNo: start + i + 1, newNo: start + j + 1 })
      i += 1
    } else {
      ops.push({ tag: "+", line: coreB[j]!, oldNo: start + i + 1, newNo: start + j + 1 })
      j += 1
    }
  }
  for (let k = endA; k < Math.min(a.length, endA + context); k += 1) {
    const offset = k - endA
    ops.push({ tag: " ", line: a[k]!, oldNo: k + 1, newNo: endB + offset + 1 })
  }

  const hunks: Array<{ old_start: number; new_start: number; lines: Array<string> }> = []
  let current: { old_start: number; new_start: number; lines: Array<string> } | undefined
  ops.forEach((op, index) => {
    const nearChange = ops
      .slice(Math.max(0, index - context), index + context + 1)
      .some((candidate) => candidate.tag !== " ")
    if (!nearChange) {
      current = undefined
      return
    }
    if (current === undefined) {
      current = { old_start: op.oldNo, new_start: op.newNo, lines: [] }
      hunks.push(current)
    }
    current.lines.push(`${op.tag}${op.line}`)
  })

  const added = ops.filter((op) => op.tag === "+").length
  const removed = ops.filter((op) => op.tag === "-").length
  return { mode: "lcs", added, removed, unchanged: a.length - removed, hunks }
}
