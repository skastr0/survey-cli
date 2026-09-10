import { Effect, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http"

import { USER_AGENT } from "./constants"
import { ApiDecodeError, ApiRequestError, ApiResponseError } from "./errors"
import { decodeUnknownJsonText } from "./json"
import { loadProviderConfig, PROVIDERS, requireCredential, type ProviderName } from "./registry"

export type HttpMethod = "GET" | "POST" | "DELETE" | "PATCH" | "PUT"

export interface RequestSpec<S extends Schema.Constraint> {
  readonly provider: ProviderName
  readonly method: HttpMethod
  readonly path: string
  readonly integration?: string
  readonly body?: unknown
  readonly formData?: FormData
  readonly headers?: Readonly<Record<string, string>>
  readonly urlParams?: Readonly<Record<string, string | ReadonlyArray<string> | number | boolean | undefined>>
  readonly responseSchema: S
}

export type TextRequestSpec = Omit<RequestSpec<Schema.Constraint>, "responseSchema">

const authHeaders = (
  provider: ProviderName,
  credential: string | undefined,
): Record<string, string> => {
  const spec = PROVIDERS[provider]
  if (!credential) {
    return {}
  }
  switch (spec.auth.kind) {
    case "header":
      return { [spec.auth.header]: credential }
    case "bearer":
      return { authorization: `Bearer ${credential}` }
    case "keenable":
      return { "x-api-key": credential }
  }
}

const baseClient = (provider: ProviderName, requireAuth: boolean) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const config = yield* loadProviderConfig(provider)
    const credential = requireAuth
      ? yield* requireCredential(provider)
      : config.credential

    const headers = authHeaders(provider, credential)

    return {
      client: client.pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(config.apiBaseUrl),
            HttpClientRequest.setHeader("user-agent", USER_AGENT),
            HttpClientRequest.setHeaders(headers),
          ),
        ),
      ),
      config,
    }
  })

const buildRequest = (
  spec: Pick<RequestSpec<Schema.Constraint>, "method" | "path" | "body" | "formData" | "headers" | "urlParams">,
) => {
  let request =
    spec.method === "GET"
      ? HttpClientRequest.get(spec.path)
      : spec.method === "DELETE"
        ? HttpClientRequest.make("DELETE")(spec.path)
        : spec.method === "PATCH"
          ? HttpClientRequest.patch(spec.path)
          : spec.method === "PUT"
            ? HttpClientRequest.put(spec.path)
            : HttpClientRequest.post(spec.path)

  if (spec.urlParams) {
    const params = Object.fromEntries(
      Object.entries(spec.urlParams).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value] as const],
      ),
    )
    request = request.pipe(HttpClientRequest.setUrlParams(params))
  }

  if (spec.formData) {
    request = request.pipe(HttpClientRequest.bodyFormData(spec.formData))
  } else if (spec.body !== undefined) {
    request = request.pipe(HttpClientRequest.bodyJsonUnsafe(spec.body))
  }

  const headerEntries = Object.entries(spec.headers ?? {})
  const hasAccept = headerEntries.some(([key]) => key.toLowerCase() === "accept")

  const withAccept = hasAccept ? request : request.pipe(HttpClientRequest.acceptJson)

  return headerEntries.reduce(
    (current, [key, value]) => current.pipe(HttpClientRequest.setHeader(key, value)),
    withAccept,
  )
}

const parseResponseBody = (text: string) =>
  text.trim().length === 0
    ? Effect.succeed<unknown | undefined>(undefined)
    : decodeUnknownJsonText(text, "api-response").pipe(
        Effect.catch(() => Effect.succeed<unknown>(text)),
      )

const extractApiMessage = (provider: ProviderName, status: number, body: unknown) => {
  if (typeof body === "string" && body.trim().length > 0) {
    return body
  }

  if (body && typeof body === "object") {
    if ("error" in body) {
      const errorValue = (body as Record<string, unknown>).error

      if (typeof errorValue === "string" && errorValue.trim().length > 0) {
        return errorValue
      }

      if (
        errorValue &&
        typeof errorValue === "object" &&
        "message" in errorValue &&
        typeof (errorValue as Record<string, unknown>).message === "string" &&
        ((errorValue as Record<string, unknown>).message as string).trim().length > 0
      ) {
        return (errorValue as Record<string, unknown>).message as string
      }
    }

    if (
      "message" in body &&
      typeof (body as Record<string, unknown>).message === "string" &&
      ((body as Record<string, unknown>).message as string).trim().length > 0
    ) {
      return (body as Record<string, unknown>).message as string
    }
  }

  return `${provider} API request failed with status ${status}`
}

const toRequestError =
  (provider: ProviderName, method: string, path: string) =>
  (error: HttpClientError.HttpClientError) =>
    new ApiRequestError({
      provider,
      method,
      path,
      reason: String(error.reason ?? error._tag ?? "RequestError"),
      message: error.message ?? "HTTP request failed",
    })

export const requestJson = <S extends Schema.Constraint>(spec: RequestSpec<S>) =>
  Effect.gen(function* () {
    const { client } = yield* baseClient(spec.provider, true)
    const request = buildRequest(spec)

    const response = yield* client.execute(request).pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    const responseText = yield* response.text.pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* parseResponseBody(responseText)

      return yield* Effect.fail(
        new ApiResponseError({
          provider: spec.provider,
          method: spec.method,
          path: spec.path,
          status: response.status,
          message: extractApiMessage(spec.provider, response.status, body),
          body,
        }),
      )
    }

    if (responseText.trim().length === 0) {
      return yield* Effect.fail(
        new ApiDecodeError({
          provider: spec.provider,
          method: spec.method,
          path: spec.path,
          message: `${spec.provider} API returned an empty response body`,
        }),
      )
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(spec.responseSchema))(responseText).pipe(
      Effect.mapError(
        (error) =>
          new ApiDecodeError({
            provider: spec.provider,
            method: spec.method,
            path: spec.path,
            message: String(error.message ?? error),
          }),
      ),
    )
  })

export const requestJsonOptionalAuth = <S extends Schema.Constraint>(spec: RequestSpec<S>) =>
  Effect.gen(function* () {
    const { client } = yield* baseClient(spec.provider, false)
    const request = buildRequest(spec)

    const response = yield* client.execute(request).pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    const responseText = yield* response.text.pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* parseResponseBody(responseText)

      return yield* Effect.fail(
        new ApiResponseError({
          provider: spec.provider,
          method: spec.method,
          path: spec.path,
          status: response.status,
          message: extractApiMessage(spec.provider, response.status, body),
          body,
        }),
      )
    }

    if (responseText.trim().length === 0) {
      return yield* Effect.fail(
        new ApiDecodeError({
          provider: spec.provider,
          method: spec.method,
          path: spec.path,
          message: `${spec.provider} API returned an empty response body`,
        }),
      )
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(spec.responseSchema))(responseText).pipe(
      Effect.mapError(
        (error) =>
          new ApiDecodeError({
            provider: spec.provider,
            method: spec.method,
            path: spec.path,
            message: String(error.message ?? error),
          }),
      ),
    )
  })

export const requestText = (spec: TextRequestSpec) =>
  Effect.gen(function* () {
    const { client } = yield* baseClient(spec.provider, true)
    const request = buildRequest(spec)

    const response = yield* client.execute(request).pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    const responseText = yield* response.text.pipe(
      Effect.mapError(toRequestError(spec.provider, spec.method, spec.path)),
    )

    if (response.status < 200 || response.status >= 300) {
      const body = yield* parseResponseBody(responseText)

      return yield* Effect.fail(
        new ApiResponseError({
          provider: spec.provider,
          method: spec.method,
          path: spec.path,
          status: response.status,
          message: extractApiMessage(spec.provider, response.status, body),
          body,
        }),
      )
    }

    return responseText
  })

export const HttpClientLayer = FetchHttpClient.layer
