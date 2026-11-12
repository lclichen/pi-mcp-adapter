/**
 * pi-web session identity integration.
 *
 * pi-web runs the adapter in its own Node process and publishes the logged-in
 * user for each session on a process-global registry:
 *
 *   globalThis[Symbol.for("@agegr/pi-web/session-identity/v1")].get(sessionId)
 *
 * The registry is the only per-session user source available to the adapter
 * (the SDK ExtensionContext exposes the session id, not the web user). Both
 * HTTP headers and MCP `_meta` carry the same identifiers:
 *
 *   headers: x-session-id, x-amedac-session-id, x-amedac-user-id,
 *            x-amedac-user-name (URI-encoded)
 *   _meta:   amedac/session_id, amedac/user_id, amedac/user_name (raw UTF-8)
 */

export const PI_WEB_SESSION_IDENTITY_KEY = "@agegr/pi-web/session-identity/v1";

export interface PiWebSessionIdentity {
  userId?: number | string;
  userName?: string;
}

interface IdentityRegistry {
  version?: number;
  get?(sessionId: string): PiWebSessionIdentity | undefined;
}

export function readPiWebSessionIdentity(sessionId: string | undefined): PiWebSessionIdentity | undefined {
  if (!sessionId) return undefined;
  try {
    const store = globalThis as Record<PropertyKey, unknown>;
    const registry = store[Symbol.for(PI_WEB_SESSION_IDENTITY_KEY)] as IdentityRegistry | undefined;
    const identity = registry?.get?.(sessionId);
    if (!identity || typeof identity !== "object") return undefined;
    return identity;
  } catch {
    return undefined;
  }
}

/** HTTP headers for MCP Streamable HTTP / SSE transports. */
export function buildMcpIdentityHeaders(sessionId: string | undefined): Record<string, string> {
  if (!sessionId) return {};
  const identity = readPiWebSessionIdentity(sessionId);
  const headers: Record<string, string> = {
    "x-session-id": sessionId,
    "x-amedac-session-id": sessionId,
  };
  if (identity?.userId !== undefined && identity.userId !== null) {
    headers["x-amedac-user-id"] = String(identity.userId);
  }
  if (identity?.userName) {
    // HTTP header values must be printable ASCII/Latin-1; keep CJK names safe.
    headers["x-amedac-user-name"] = encodeURIComponent(identity.userName);
  }
  return headers;
}

/** Protocol-level `_meta` fields sent with every tools/call request. */
export function buildMcpIdentityMeta(sessionId: string | undefined): Record<string, unknown> | undefined {
  if (!sessionId) return undefined;
  const identity = readPiWebSessionIdentity(sessionId);
  return {
    "amedac/session_id": sessionId,
    ...(identity?.userId !== undefined && identity.userId !== null
      ? { "amedac/user_id": identity.userId }
      : {}),
    ...(identity?.userName ? { "amedac/user_name": identity.userName } : {}),
  };
}
