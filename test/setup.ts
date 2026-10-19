/**
 * Unit tests must never reach live provider APIs (AGENTS.md). Keyless
 * fallbacks make that easy to miss: a provider that refuses one network (e.g.
 * Firecrawl's keyless 403 for VPN IPs) can mask a live call that succeeds in
 * CI. Any fetch to a non-loopback host fails loudly instead.
 */
const realFetch = globalThis.fetch

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error(`Live network call blocked in tests: ${url.origin}`))
  }
  return realFetch(input, init)
}) as typeof fetch
