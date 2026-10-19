import { Effect, Schema } from "effect"

import {
  KeylessOnly,
  loadProviderConfig,
  PROVIDERS,
  providerNames,
  type Capability,
  type ProviderName,
} from "./registry"

/**
 * Provider capabilities that work without an API key (`public`) or run on this
 * machine (`local`). Every other capability a provider lists in PROVIDERS needs
 * a key, and keyed calls spend account credits. Adding a provider means adding
 * one entry here, and only if it has keyless or local capabilities.
 */
export interface TierRule {
  readonly public?: ReadonlyArray<Capability>
  readonly local?: ReadonlyArray<Capability>
}

export const TIER_RULES: Partial<Record<ProviderName, TierRule>> = {
  // POST /v1/search/public, GET /v1/fetch/public.
  keenable: { public: ["search", "fetch"] },
  // https://www.firecrawl.dev/agent-onboarding/SKILL.md, "Path F: Keyless Free Tier":
  // /v2/search, /v2/scrape, /v2/parse, interact, /v2/search/research/* need no key.
  firecrawl: { public: ["search", "fetch", "parse", "interact", "papers"] },
}

export const AccessMode = Schema.Literals(["keyed", "public", "local", "unavailable"])
export type AccessMode = typeof AccessMode.Type

/** `paid` spends account credits (including free-plan allowances); `free` never does. */
export const Cost = Schema.Literals(["free", "paid"])
export type Cost = typeof Cost.Type

/** Routing restriction for unified commands. `free` keeps only keyless or local access. */
export const Tier = Schema.Literals(["free", "any"])
export type Tier = typeof Tier.Type

export interface Access {
  readonly available: boolean
  readonly mode: AccessMode
  readonly cost: Cost | null
}

const UNAVAILABLE: Access = { available: false, mode: "unavailable", cost: null }

/** Pure resolution: how `provider` would serve `capability` given whether a key is present. */
export const resolveAccess = (
  provider: ProviderName,
  capability: Capability,
  keyed: boolean,
): Access => {
  if (!PROVIDERS[provider].capabilities.includes(capability)) {
    return UNAVAILABLE
  }
  const rule = TIER_RULES[provider]
  if (rule?.local?.includes(capability)) {
    return { available: true, mode: "local", cost: "free" }
  }
  if (keyed) {
    return { available: true, mode: "keyed", cost: "paid" }
  }
  if (rule?.public?.includes(capability)) {
    return { available: true, mode: "public", cost: "free" }
  }
  return UNAVAILABLE
}

/** Resolve access against the live config (env, auth file, KeylessOnly). */
export const providerAccess = Effect.fn("providerAccess")(function* (
  provider: ProviderName,
  capability: Capability,
) {
  const config = yield* loadProviderConfig(provider)
  return resolveAccess(provider, capability, config.credential !== undefined)
})

/** Every provider × listed capability, resolved against the live config. */
export const accessMatrix = Effect.gen(function* () {
  return yield* Effect.forEach(providerNames, (provider) =>
    Effect.gen(function* () {
      const config = yield* loadProviderConfig(provider)
      const keyed = config.credential !== undefined
      return {
        provider,
        capabilities: Object.fromEntries(
          PROVIDERS[provider].capabilities.map((capability) => [
            capability,
            resolveAccess(provider, capability, keyed),
          ]),
        ) as Record<string, Access>,
      }
    }),
  )
})

/** Static view for `capabilities`: which access modes each capability can use. */
export const tierTable = () =>
  providerNames.map((provider) => {
    const rule = TIER_RULES[provider]
    return {
      provider,
      capabilities: Object.fromEntries(
        PROVIDERS[provider].capabilities.map((capability) => [
          capability,
          rule?.local?.includes(capability)
            ? ["local"]
            : rule?.public?.includes(capability)
              ? ["keyed", "public"]
              : ["keyed"],
        ]),
      ) as Record<string, ReadonlyArray<AccessMode>>,
    }
  })

export interface RoutedProvider {
  readonly provider: ProviderName
  readonly access: Access
}

export interface SkippedProvider {
  readonly provider: string
  readonly reason: string
}

/**
 * Split requested providers into eligible and skipped for one capability.
 * `adapters` lists the providers the calling command can actually drive.
 * `capability` may vary per provider (e.g. verify uses Exa answer, Parallel tasks).
 */
export const routeProviders = Effect.fn("routeProviders")(function* (options: {
  readonly requested: ReadonlyArray<ProviderName>
  readonly adapters: ReadonlyArray<ProviderName>
  readonly capability: Capability | ((provider: ProviderName) => Capability)
  readonly tier?: Tier | undefined
}) {
  const eligible: Array<RoutedProvider> = []
  const skipped: Array<SkippedProvider> = []
  const free = options.tier === "free"
  for (const provider of options.requested) {
    const capability =
      typeof options.capability === "function"
        ? options.capability(provider)
        : options.capability
    if (!options.adapters.includes(provider)) {
      skipped.push({ provider, reason: `no ${capability} adapter for this command` })
      continue
    }
    const access = yield* providerAccess(provider, capability).pipe(
      Effect.provideService(KeylessOnly, free || (yield* KeylessOnly)),
    )
    if (!access.available) {
      skipped.push({
        provider,
        reason: !PROVIDERS[provider].capabilities.includes(capability)
          ? `provider does not support ${capability}`
          : free
            ? `tier free: ${capability} needs an API key (paid)`
            : "no API key configured",
      })
      continue
    }
    eligible.push({ provider, access })
  }
  return { eligible, skipped }
})

/** Run `effect` with credentials hidden when the caller asked for the free tier. */
export const withTier = (tier: Tier | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    tier === "free" ? Effect.provideService(effect, KeylessOnly, true) : effect
