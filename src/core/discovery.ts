import { Schema } from "effect"

export interface CommandExample {
  readonly name: string
  readonly description?: string
  readonly input: unknown
}

export interface CommandContract {
  readonly command: string
  readonly description: string
  readonly inputSchema?: Schema.Constraint
  readonly examples?: ReadonlyArray<CommandExample>
  readonly batch?: boolean
  readonly orbit?: ReadonlyArray<string>
  readonly output?: string
}

const contracts = new Map<string, CommandContract>()

export const registerContract = (contract: CommandContract) => {
  contracts.set(contract.command, contract)
}

export const registerContracts = (list: ReadonlyArray<CommandContract>) => {
  for (const contract of list) {
    registerContract(contract)
  }
}

export const listContracts = () =>
  [...contracts.values()].sort((a, b) => a.command.localeCompare(b.command))

export const getContract = (command: string) => contracts.get(command)

const globToRegex = (glob: string) =>
  new RegExp(`^${glob.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)

/** Command-path globs (`corpus *`, `research*`); `_` matches a space so MCP tool names work too. */
export const matchesCommandGlob = (command: string, globs: ReadonlyArray<string>) =>
  globs.some((glob) => globToRegex(glob).test(command) || globToRegex(glob.replace(/_/g, " ")).test(command))

const isNullBranch = (value: unknown) =>
  typeof value === "object" && value !== null && (value as Record<string, unknown>).type === "null" &&
  Object.keys(value).length === 1

/**
 * Optional keys render as `anyOf: [T, {type: "null"}]`, but input decoding
 * rejects null (an omitted key is the only "absent" form). Strip those
 * branches so the advertised schema matches what the CLI accepts.
 */
export const stripNullBranches = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNullBranches)
  if (typeof value !== "object" || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    out[key] = stripNullBranches(nested)
  }
  const anyOf = out.anyOf
  if (Array.isArray(anyOf) && anyOf.some(isNullBranch)) {
    const rest = anyOf.filter((branch) => !isNullBranch(branch))
    delete out.anyOf
    if (rest.length === 1) {
      return { ...(rest[0] as Record<string, unknown>), ...out }
    }
    out.anyOf = rest
  }
  return out
}

export const contractJsonSchema = (contract: CommandContract) =>
  contract.inputSchema
    ? (stripNullBranches(Schema.toJsonSchemaDocument(contract.inputSchema)) as ReturnType<
        typeof Schema.toJsonSchemaDocument
      >)
    : undefined
