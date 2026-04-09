/**
 * Tests for session validation logic.
 *
 * Mocks the WorkOS SDK to avoid real API calls.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock WorkOS SDK at the module level
// ---------------------------------------------------------------------------

const mockAuthenticateWithSessionCookie = vi.fn();
const mockGetAuthorizationUrl = vi.fn();
const mockGetLogoutUrl = vi.fn();
const mockAuthenticateWithCode = vi.fn();

vi.mock("@workos-inc/node", () => {
  return {
    WorkOS: vi.fn().mockImplementation(() => ({
      userManagement: {
        authenticateWithSessionCookie: mockAuthenticateWithSessionCookie,
        getAuthorizationUrl: mockGetAuthorizationUrl,
        getLogoutUrl: mockGetLogoutUrl,
        authenticateWithCode: mockAuthenticateWithCode,
      },
    })),
  };
});

// Set required env vars before importing auth module
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("WORKOS_API_KEY", "sk_test_1234");
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test_1234");
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a_very_long_secret_password_for_testing_32chars!");
  vi.stubEnv("WORKOS_REDIRECT_URI", "http://localhost:5173/auth/callback");

  mockAuthenticateWithSessionCookie.mockReset();
  mockGetAuthorizationUrl.mockReset();
  mockGetLogoutUrl.mockReset();
  mockAuthenticateWithCode.mockReset();
});

// Dynamic import to ensure env vars are set
async function getAuth() {
  const mod = await import("$lib/server/auth");
  mod.resetWorkOS();
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateSession", () => {
  it("returns unauthenticated when no session data is provided", async () => {
    const { validateSession } = await getAuth();
    const result = await validateSession(undefined);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe("no_session_cookie");
    }
    // WorkOS SDK should not be called
    expect(mockAuthenticateWithSessionCookie).not.toHaveBeenCalled();
  });

  it("returns authenticated with user data for a valid session", async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: true,
      sessionId: "session_abc123",
      user: {
        id: "user_01ABC",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
      },
    });

    const { validateSession } = await getAuth();
    const result = await validateSession("sealed_session_data");

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.sessionId).toBe("session_abc123");
      expect(result.user.workosId).toBe("user_01ABC");
      expect(result.user.email).toBe("alice@example.com");
      expect(result.user.firstName).toBe("Alice");
      expect(result.user.lastName).toBe("Smith");
    }

    expect(mockAuthenticateWithSessionCookie).toHaveBeenCalledWith({
      sessionData: "sealed_session_data",
      cookiePassword: "a_very_long_secret_password_for_testing_32chars!",
    });
  });

  it("returns unauthenticated when WorkOS reports invalid JWT", async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: false,
      reason: "invalid_jwt",
    });

    const { validateSession } = await getAuth();
    const result = await validateSession("expired_session_data");

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe("invalid_jwt");
    }
  });

  it("returns unauthenticated when WorkOS reports invalid session cookie", async () => {
    mockAuthenticateWithSessionCookie.mockResolvedValueOnce({
      authenticated: false,
      reason: "invalid_session_cookie",
    });

    const { validateSession } = await getAuth();
    const result = await validateSession("corrupted_data");

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe("invalid_session_cookie");
    }
  });
});

describe("exchangeCodeForSession", () => {
  it("returns user and sealed session on successful code exchange", async () => {
    mockAuthenticateWithCode.mockResolvedValueOnce({
      user: {
        id: "user_01XYZ",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Jones",
      },
      sealedSession: "sealed_abc",
    });

    const { exchangeCodeForSession } = await getAuth();
    const result = await exchangeCodeForSession("auth_code_123");

    expect(result.user.id).toBe("user_01XYZ");
    expect(result.user.email).toBe("bob@example.com");
    expect(result.sealedSession).toBe("sealed_abc");
  });

  it("throws when WorkOS does not return a sealed session", async () => {
    mockAuthenticateWithCode.mockResolvedValueOnce({
      user: { id: "user_01XYZ", email: "bob@example.com" },
      // sealedSession is missing
    });

    const { exchangeCodeForSession } = await getAuth();
    await expect(exchangeCodeForSession("auth_code_123")).rejects.toThrow(
      "WorkOS did not return a sealed session",
    );
  });
});

describe("getAuthorizationUrl", () => {
  it("calls WorkOS with correct parameters", async () => {
    mockGetAuthorizationUrl.mockReturnValueOnce(
      "https://api.workos.com/user_management/authorize?...",
    );

    const { getAuthorizationUrl } = await getAuth();
    const url = getAuthorizationUrl();

    expect(url).toBe("https://api.workos.com/user_management/authorize?...");
    expect(mockGetAuthorizationUrl).toHaveBeenCalledWith({
      provider: "authkit",
      clientId: "client_test_1234",
      redirectUri: "http://localhost:5173/auth/callback",
    });
  });
});

describe("getLogoutUrl", () => {
  it("returns a logout URL with session ID", async () => {
    mockGetLogoutUrl.mockReturnValueOnce(
      "https://api.workos.com/user_management/sessions/logout?session_id=sess_123",
    );

    const { getLogoutUrl } = await getAuth();
    const url = getLogoutUrl("sess_123");

    expect(url).toContain("logout");
    expect(mockGetLogoutUrl).toHaveBeenCalledWith({
      sessionId: "sess_123",
      returnTo: "http://localhost:5173/login",
    });
  });
});
