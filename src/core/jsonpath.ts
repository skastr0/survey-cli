/**
 * Tiny JSONPath subset for pipeline references:
 *   $.step.data.results[0].url   keys and indexes
 *   $.step.data.results[*].url   wildcard (maps over arrays / object values)
 *   $.step.data.results[0:5]     slices (negative bounds allowed)
 *   $item / $item.url / $index   current foreach element
 * A string that is exactly one reference resolves to the referenced value;
 * `{{ ref }}` inside a longer string interpolates. `$$` escapes a literal `$`.
 */

type Segment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "wildcard" }
  | { readonly kind: "slice"; readonly start: number | undefined; readonly end: number | undefined }

export class PathError extends Error {}

const parseSegments = (path: string): Array<Segment> => {
  const segments: Array<Segment> = []
  let rest = path
  while (rest.length > 0) {
    const key = /^\.([A-Za-z0-9_\-]+)/.exec(rest)
    if (key !== null) {
      segments.push({ kind: "key", key: key[1]! })
      rest = rest.slice(key[0].length)
      continue
    }
    const bracket = /^\[([^\]]*)\]/.exec(rest)
    if (bracket !== null) {
      const body = bracket[1]!.trim()
      if (body === "*") {
        segments.push({ kind: "wildcard" })
      } else if (/^-?\d*:-?\d*$/.test(body)) {
        const [start, end] = body.split(":")
        segments.push({
          kind: "slice",
          start: start === "" ? undefined : Number(start),
          end: end === "" ? undefined : Number(end),
        })
      } else if (/^-?\d+$/.test(body)) {
        segments.push({ kind: "index", index: Number(body) })
      } else if (/^(["']).*\1$/.test(body)) {
        segments.push({ kind: "key", key: body.slice(1, -1) })
      } else {
        throw new PathError(`Invalid bracket segment [${body}]`)
      }
      rest = rest.slice(bracket[0].length)
      continue
    }
    throw new PathError(`Cannot parse path at "${rest}"`)
  }
  return segments
}

const apply = (value: unknown, segments: ReadonlyArray<Segment>): unknown => {
  if (segments.length === 0) return value
  const [head, ...tail] = segments
  const fansOut = tail.some((segment) => segment.kind === "wildcard" || segment.kind === "slice")
  switch (head!.kind) {
    case "key":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? apply((value as Record<string, unknown>)[head!.key], tail)
        : undefined
    case "index": {
      if (!Array.isArray(value)) return undefined
      const index = head!.index < 0 ? value.length + head!.index : head!.index
      return apply(value[index], tail)
    }
    case "wildcard":
    case "slice": {
      const items =
        head!.kind === "slice"
          ? Array.isArray(value)
            ? value.slice(head!.start, head!.end)
            : undefined
          : Array.isArray(value)
            ? value
            : value !== null && typeof value === "object"
              ? Object.values(value)
              : undefined
      if (items === undefined) return undefined
      // Nested fan-outs flatten one level so `a[*].b[*]` yields a flat list.
      return items.flatMap((item) => {
        const resolved = apply(item, tail)
        return fansOut && Array.isArray(resolved) ? resolved : [resolved]
      })
    }
  }
}

export interface Scope {
  readonly root: Record<string, unknown>
  readonly item?: unknown
  readonly index?: number
}

const REF = /^\$(item|index)?((?:\.[A-Za-z0-9_\-]+|\[[^\]]*\])*)$/

export const isReference = (value: string) => REF.test(value.trim()) && value.trim() !== "$"

export const resolveReference = (ref: string, scope: Scope): unknown => {
  const match = REF.exec(ref.trim())
  if (match === null) throw new PathError(`Not a reference: ${ref}`)
  const base = match[1] === "item" ? scope.item : match[1] === "index" ? scope.index : scope.root
  return apply(base, parseSegments(match[2] ?? ""))
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g

/** Deep-resolve references and templates inside an arbitrary JSON value. */
export const resolveValue = (value: unknown, scope: Scope): unknown => {
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1)
    if (value.startsWith("$") && isReference(value)) return resolveReference(value, scope)
    if (value.includes("{{")) {
      return value.replace(TEMPLATE, (_whole, ref: string) => {
        const resolved = resolveReference(ref, scope)
        return resolved === undefined || resolved === null
          ? ""
          : typeof resolved === "string"
            ? resolved
            : JSON.stringify(resolved)
      })
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveValue(nested, scope)]))
  }
  return value
}
