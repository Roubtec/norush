/**
 * WorkOS AuthKit initialization and session helpers.
 *
 * Provides a singleton WorkOS client and functions for session management
 * using sealed cookies (iron-session-style encryption via WorkOS SDK).
 *
 * Required environment variables:
 * - WORKOS_API_KEY: Server-side WorkOS API key (sk_...)
 * - WORKOS_CLIENT_ID: WorkOS client ID
 * - WORKOS_COOKIE_PASSWORD: 32+ char secret for sealing session cookies
 * - WORKOS_REDIRECT_URI: OAuth callback URL (e.g. http://localhost:5173/auth/callback)
 */

import { WorkOS } from '@workos-inc/node';
import type { User as WorkOSUser } from '@workos-inc/node';

export type { WorkOSUser };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'norush_session';

/** Max-age for the session cookie (30 days). */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Singleton WorkOS client
// ---------------------------------------------------------------------------

let _workos: WorkOS | undefined;

export function getWorkOS(): WorkOS {
  if (!_workos) {
    const apiKey = getEnvOrThrow('WORKOS_API_KEY');
    const clientId = getEnvOrThrow('WORKOS_CLIENT_ID');
    _workos = new WorkOS(apiKey, { clientId });
  }
  return _workos;
}

/** Exposed for testing: replace the singleton. */
export function setWorkOS(instance: WorkOS): void {
  _workos = instance;
}

/** Exposed for testing: reset the singleton. */
export function resetWorkOS(): void {
  _workos = undefined;
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function getAuthorizationUrl(): string {
  const workos = getWorkOS();
  const redirectUri = getEnvOrThrow('WORKOS_REDIRECT_URI');
  const clientId = getEnvOrThrow('WORKOS_CLIENT_ID');

  return workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId,
    redirectUri,
  });
}

// ---------------------------------------------------------------------------
// Code exchange (OAuth callback)
// ---------------------------------------------------------------------------

export interface AuthResult {
  user: WorkOSUser;
  sealedSession: string;
}

export async function exchangeCodeForSession(code: string): Promise<AuthResult> {
  const workos = getWorkOS();
  const cookiePassword = getEnvOrThrow('WORKOS_COOKIE_PASSWORD');

  const authResponse = await workos.userManagement.authenticateWithCode({
    code,
    session: {
      sealSession: true,
      cookiePassword,
    },
  });

  if (!authResponse.sealedSession) {
    throw new Error('WorkOS did not return a sealed session');
  }

  return {
    user: authResponse.user,
    sealedSession: authResponse.sealedSession,
  };
}

// ---------------------------------------------------------------------------
// Session validation (from cookie)
// ---------------------------------------------------------------------------

export interface SessionUser {
  /** WorkOS user ID (e.g. user_01ABC...) */
  workosId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface ValidSession {
  authenticated: true;
  sessionId: string;
  user: SessionUser;
}

export interface InvalidSession {
  authenticated: false;
  reason: string;
}

export type SessionResult = ValidSession | InvalidSession;

export async function validateSession(sessionData: string | undefined): Promise<SessionResult> {
  if (!sessionData) {
    return { authenticated: false, reason: 'no_session_cookie' };
  }

  const workos = getWorkOS();
  const cookiePassword = getEnvOrThrow('WORKOS_COOKIE_PASSWORD');

  const result = await workos.userManagement.authenticateWithSessionCookie({
    sessionData,
    cookiePassword,
  });

  if (!result.authenticated) {
    return { authenticated: false, reason: result.reason };
  }

  return {
    authenticated: true,
    sessionId: result.sessionId,
    user: {
      workosId: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
    },
  };
}

// ---------------------------------------------------------------------------
// Logout URL
// ---------------------------------------------------------------------------

export function getLogoutUrl(sessionId: string): string {
  const workos = getWorkOS();
  const redirectUri = getEnvOrThrow('WORKOS_REDIRECT_URI');
  // Redirect to /login after logout
  const returnTo = new URL(redirectUri).origin + '/login';

  return workos.userManagement.getLogoutUrl({
    sessionId,
    returnTo,
  });
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
export const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: COOKIE_MAX_AGE_SECONDS,
};
