import { describe, expect, test } from "bun:test"
import {
  GoogleAuthPlugin,
  generatePKCE,
  base64UrlEncode,
  generateRandomString,
  type AccountTier,
} from "../../src/plugin/google"
import { GoogleOAuthError, GoogleOAuthCancelledError, GoogleOAuthTimeoutError } from "../../src/plugin/google"

describe("Google OAuth Plugin", () => {
  describe("PKCE Generation", () => {
    test("should generate valid PKCE codes", async () => {
      const pkce = await generatePKCE()
      expect(pkce.verifier).toBeDefined()
      expect(pkce.challenge).toBeDefined()
      expect(pkce.verifier.length).toBe(128)
      expect(pkce.challenge.length).toBeGreaterThan(0)
    })

    test("should generate unique PKCE codes", async () => {
      const pkce1 = await generatePKCE()
      const pkce2 = await generatePKCE()
      expect(pkce1.verifier).not.toBe(pkce2.verifier)
      expect(pkce1.challenge).not.toBe(pkce2.challenge)
    })
  })

  describe("Base64 URL Encoding", () => {
    test("should encode buffer correctly", () => {
      const buffer = new Uint8Array([0, 1, 2, 3, 255]).buffer
      const encoded = base64UrlEncode(buffer)
      expect(encoded).not.toContain("+")
      expect(encoded).not.toContain("/")
      expect(encoded).not.toContain("=")
    })
  })

  describe("Random String Generation", () => {
    test("should generate string of correct length", () => {
      const str = generateRandomString(43)
      expect(str.length).toBe(43)
    })

    test("should generate valid PKCE characters", () => {
      const str = generateRandomString(100)
      const validChars = /^[A-Za-z0-9-._~]+$/
      expect(validChars.test(str)).toBe(true)
    })
  })

  describe("Error Classes", () => {
    test("GoogleOAuthError should have correct properties", () => {
      const error = new GoogleOAuthError({ message: "Test error", code: "TEST_CODE" })
      expect(error.name).toBe("GoogleOAuthError")
      expect(error).toBeInstanceOf(Error)
    })

    test("GoogleOAuthCancelledError should be instantiable", () => {
      const error = new GoogleOAuthCancelledError({})
      expect(error.name).toBe("GoogleOAuthCancelledError")
    })

    test("GoogleOAuthTimeoutError should be instantiable", () => {
      const error = new GoogleOAuthTimeoutError({})
      expect(error.name).toBe("GoogleOAuthTimeoutError")
    })
  })

  describe("Plugin Export", () => {
    test("should export GoogleAuthPlugin function", () => {
      expect(typeof GoogleAuthPlugin).toBe("function")
    })
  })
})
