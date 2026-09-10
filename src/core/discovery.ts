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

export const contractJsonSchema = (contract: CommandContract) =>
  contract.inputSchema
    ? Schema.toJsonSchemaDocument(contract.inputSchema)
    : undefined
