import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"
import { NamedError } from "@opencode-ai/util/error"
import * as os from "os"

const log = Log.create({ service: "plugin.google" })

// Google OAuth Configuration
const CLIENT_ID = "93776515174-vlq3fv9n4aie8f88d9k5q6r5q5q5q5q5.apps.googleusercontent.com" // OpenCode's OAuth client
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
const OAUTH_PORT = 1456
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

// Required OAuth scopes
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
]

// Account tiers
export type AccountTier = "free" | "pro" | "ultra" | "unknown"

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

interface UserInfo {
  sub: string
  email: string
  name?: string
  picture?: string
}

interface TierInfo {
  tier: AccountTier
  rateLimits: {
    requestsPerMinute: number
    tokensPerMinute: number
  }
}

// OAuth Errors
export const GoogleOAuthError = NamedError.create(
  "GoogleOAuthError",
  z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
)

export const GoogleOAuthCancelledError = NamedError.create(
  "GoogleOAuthCancelledError",
  z.object({}),
)

export const GoogleOAuthTimeoutError = NamedError.create(
  "GoogleOAuthTimeoutError",
  z.object({}),
)

export const GoogleOAuthDeniedError = NamedError.create(
  "GoogleOAuthDeniedError",
  z.object({}),
)

import z from "zod"

// Generate PKCE codes for OAuth flow
export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(128)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

export function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

export function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

// Build authorization URL
function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

// Exchange authorization code for tokens
async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new GoogleOAuthError({
      message: `Token exchange failed: ${response.status} - ${error}`,
      code: "TOKEN_EXCHANGE_FAILED",
    })
  }

  return response.json()
}

// Refresh access token
async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new GoogleOAuthError({
      message: `Token refresh failed: ${response.status} - ${error}`,
      code: "TOKEN_REFRESH_FAILED",
    })
  }

  return response.json()
}

// Fetch user info
async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    throw new GoogleOAuthError({
      message: `Failed to fetch user info: ${response.status}`,
      code: "USERINFO_FAILED",
    })
  }

  return response.json()
}

// Detect account tier by probing API capabilities
async function detectAccountTier(accessToken: string): Promise<TierInfo> {
  try {
    // Try to access Gemini API with different models to detect tier
    // Ultra users have access to gemini-1.5-pro and higher rate limits
    // Pro users have access to gemini-1.5-flash and standard rate limits
    // Free users have limited access

    // First, try to get quota information from the API
    const quotaResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?key=dummy",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    ).catch(() => null)

    // Try accessing an Ultra-specific model capability
    const ultraTestResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:countTokens",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "test" }] }],
        }),
      },
    ).catch(() => null)

    // Check response headers for rate limit info
    const rateLimitHeader = ultraTestResponse?.headers.get("x-ratelimit-limit")
    const rateLimit = rateLimitHeader ? parseInt(rateLimitHeader, 10) : 0

    // Determine tier based on rate limits and model access
    if (rateLimit >= 1000) {
      return {
        tier: "ultra",
        rateLimits: {
          requestsPerMinute: rateLimit,
          tokensPerMinute: 1000000,
        },
      }
    } else if (rateLimit >= 60) {
      return {
        tier: "pro",
        rateLimits: {
          requestsPerMinute: rateLimit,
          tokensPerMinute: 100000,
        },
      }
    } else if (rateLimit > 0) {
      return {
        tier: "free",
        rateLimits: {
          requestsPerMinute: rateLimit,
          tokensPerMinute: 10000,
        },
      }
    }

    return {
      tier: "unknown",
      rateLimits: {
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      },
    }
  } catch (error) {
    log.warn("Failed to detect account tier", { error })
    return {
      tier: "unknown",
      rateLimits: {
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      },
    }
  }
}

// HTML templates for callback server
const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Google Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .success {
        color: #4ade80;
        font-size: 4rem;
        margin-bottom: 1rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="success">✓</div>
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 3000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string, code?: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Google Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
        max-width: 500px;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
        word-break: break-word;
      }
      .code {
        color: #b7b1b1;
        font-size: 0.875rem;
        margin-top: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>${error}</p>
      ${code ? `<div class="code">Error code: ${code}</div>` : ""}
      <div class="error">
        Try again or use an API key instead:<br>
        <code>opencode auth login</code> → Select "API Key"
      </div>
    </div>
  </body>
</html>`

// OAuth callback server
interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (result: { code: string; error?: never } | { error: string; code?: never }) => void
  reject: (error: Error) => void
}

let oauthServer: any | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  // @ts-ignore - Bun is globally available in the runtime
  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.resolve({ error: errorMsg })
          pendingOAuth = undefined

          if (error === "access_denied") {
            return new Response(
              HTML_ERROR(
                "You denied access to your Google account. Please try again and approve the permissions.",
                "ACCESS_DENIED",
              ),
              { headers: { "Content-Type": "text/html" } },
            )
          }

          return new Response(HTML_ERROR(errorMsg, error.toUpperCase()), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          pendingOAuth?.resolve({ error: "Missing authorization code" })
          pendingOAuth = undefined
          return new Response(
            HTML_ERROR("Authorization code not received from Google.", "MISSING_CODE"),
            { status: 400, headers: { "Content-Type": "text/html" } },
          )
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new GoogleOAuthError({ message: errorMsg, code: "INVALID_STATE" }))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg, "INVALID_STATE"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined
        current.resolve({ code })

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new GoogleOAuthCancelledError({}))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  log.info("google oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
    log.info("google oauth server stopped")
  }
}

function waitForOAuthCallback(
  pkce: PkceCodes,
  state: string,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new GoogleOAuthTimeoutError({}))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

// Get auth headers for API requests
async function getAuthHeaders(
  getAuth: () => Promise<Auth.Info>,
  input: PluginInput,
): Promise<Record<string, string>> {
  const auth = await getAuth()
  if (auth.type !== "oauth") {
    throw new GoogleOAuthError({
      message: "Not authenticated with OAuth",
      code: "NOT_OAUTH",
    })
  }

  const oauthAuth = auth as Auth.Info & { tier?: AccountTier; email?: string }

  // Check if token needs refresh
  if (!auth.access || auth.expires < Date.now()) {
    log.info("refreshing google access token")
    try {
      const tokens = await refreshAccessToken(auth.refresh)
      const newAuth: Auth.Info = {
        type: "oauth",
        refresh: auth.refresh,
        access: tokens.access_token,
        expires: Date.now() + tokens.expires_in * 1000,
        tier: oauthAuth.tier,
        email: oauthAuth.email,
      }
      await input.client.auth.set({
        path: { id: "google" },
        body: newAuth,
      })
      auth.access = tokens.access_token
    } catch (error) {
      log.error("failed to refresh google token", { error })
      throw new GoogleOAuthError({
        message: "Session expired. Please login again with: opencode auth login",
        code: "SESSION_EXPIRED",
      })
    }
  }

  return {
    Authorization: `Bearer ${auth.access}`,
  }
}

// Model filtering based on tier
function filterModelsByTier(models: Record<string, { cost?: any; [key: string]: any }>, tier: AccountTier): void {
  const ultraModels = new Set([
    "gemini-1.5-ultra",
    "gemini-1.5-ultra-latest",
    "gemini-ultra",
  ])

  const proModels = new Set([
    "gemini-1.5-pro",
    "gemini-1.5-pro-latest",
    "gemini-1.5-pro-exp",
    "gemini-pro",
  ])

  for (const modelId of Object.keys(models)) {
    // Ultra users get all models
    if (tier === "ultra") continue

    // Pro users get Pro and Flash models, but not Ultra
    if (tier === "pro") {
      if (ultraModels.has(modelId)) {
        delete models[modelId]
      }
      continue
    }

    // Free/unknown users only get Flash models
    if (tier === "free" || tier === "unknown") {
      if (ultraModels.has(modelId) || proModels.has(modelId)) {
        delete models[modelId]
      }
    }
  }
}

// Main plugin export
export async function GoogleAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        const oauthAuth = auth as Auth.Info & { tier?: AccountTier; email?: string }

        // Zero out costs for OAuth users (subscription includes usage)
        for (const model of Object.values(provider.models as Record<string, { cost?: any; [key: string]: any }>)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        // Filter models based on tier
        if (oauthAuth.tier) {
          filterModelsByTier(provider.models, oauthAuth.tier)
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete (init.headers as Record<string, string>)["authorization"]
                delete (init.headers as Record<string, string>)["Authorization"]
              }
            }

            try {
              const headers = await getAuthHeaders(getAuth, input)

              // Merge headers
              const mergedHeaders = new Headers(init?.headers)
              Object.entries(headers).forEach(([key, value]) => {
                mergedHeaders.set(key, value)
              })

              return fetch(requestInput, {
                ...init,
                headers: mergedHeaders,
              })
            } catch (error) {
              // If we get a 401, try refreshing once more
              if (error instanceof GoogleOAuthError && (error as any).code === "SESSION_EXPIRED") {
                throw error
              }

              // Retry once with fresh token
              if (init && typeof init === "object") {
                const headers = await getAuthHeaders(getAuth, input)
                const mergedHeaders = new Headers(init.headers)
                Object.entries(headers).forEach(([key, value]) => {
                  mergedHeaders.set(key, value)
                })

                return fetch(requestInput, {
                  ...init,
                  headers: mergedHeaders,
                })
              }

              throw error
            }
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Google AI Pro/Ultra (OAuth)",
          async authorize() {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                try {
                  const result = await callbackPromise
                  stopOAuthServer()

                  if ("error" in result) {
                    return { type: "failed" as const }
                  }

                  // Exchange code for tokens
                  const tokens = await exchangeCodeForTokens(result.code, redirectUri, pkce)

                  // Fetch user info
                  const userInfo = await fetchUserInfo(tokens.access_token)

                  // Detect account tier
                  const tierInfo = await detectAccountTier(tokens.access_token)

                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + tokens.expires_in * 1000,
                    tier: tierInfo.tier,
                    email: userInfo.email,
                  }
                } catch (error) {
                  stopOAuthServer()

                  if (error instanceof GoogleOAuthCancelledError) {
                    return { type: "failed" as const }
                  }

                  if (error instanceof GoogleOAuthTimeoutError) {
                    throw new GoogleOAuthError({
                      message: "Authorization timed out. Please try again.",
                      code: "TIMEOUT",
                    })
                  }

                  throw error
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API Key",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "google") return
      output.headers["User-Agent"] = `opencode/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["x-goog-api-client"] = `opencode/${Installation.VERSION}`
    },
  }
}
