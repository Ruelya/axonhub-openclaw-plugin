/**
 * AxonHub URL normalization and protocol endpoint resolution.
 *
 * AxonHub exposes multiple protocol surfaces:
 * - `/v1` — OpenAI Chat Completions / Responses API
 * - `/anthropic/v1` — Anthropic Messages API
 * - `/gemini/v1beta` — Google Gemini API
 *
 * This module normalizes user-provided base URLs into an instance root
 * and derives per-protocol endpoints.
 */

/**
 * Normalize a user-provided AxonHub URL into the instance root.
 * Strips trailing slashes and the `/v1` suffix if present.
 *
 * @example
 * normalizeAxonhubInstanceRoot("http://localhost:8090/v1") → "http://localhost:8090"
 * normalizeAxonhubInstanceRoot("https://axonhub.example.com/") → "https://axonhub.example.com"
 */
export function normalizeAxonhubInstanceRoot(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/**
 * Derive the OpenAI-compatible endpoint (Chat Completions and Responses).
 */
export function getAxonhubOpenAIEndpoint(instanceRoot: string): string {
  return `${normalizeAxonhubInstanceRoot(instanceRoot)}/v1`;
}

/**
 * Derive the Anthropic Messages API endpoint.
 */
export function getAxonhubAnthropicEndpoint(instanceRoot: string): string {
  return `${normalizeAxonhubInstanceRoot(instanceRoot)}/anthropic/v1`;
}

/**
 * Derive the Google Gemini API endpoint.
 */
export function getAxonhubGeminiEndpoint(instanceRoot: string): string {
  return `${normalizeAxonhubInstanceRoot(instanceRoot)}/gemini/v1beta`;
}
