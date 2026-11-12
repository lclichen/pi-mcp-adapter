import { beforeEach, describe, expect, it } from "vitest";
import {
  PI_WEB_SESSION_IDENTITY_KEY,
  buildMcpIdentityHeaders,
  buildMcpIdentityMeta,
  readPiWebSessionIdentity,
} from "../session-identity.ts";
import { buildMcpRequestMeta } from "../state.ts";

const KEY = Symbol.for(PI_WEB_SESSION_IDENTITY_KEY);
const identities = new Map<string, { userId?: number | string; userName?: string }>();

beforeEach(() => {
  identities.clear();
  (globalThis as Record<PropertyKey, unknown>)[KEY] = {
    version: 1,
    get: (sessionId: string) => identities.get(sessionId),
  };
});

describe("pi-web session identity integration", () => {
  it("maps the session/user identity to HTTP headers", () => {
    identities.set("s-1", { userId: 7, userName: "Alice 张" });
    expect(buildMcpIdentityHeaders("s-1")).toEqual({
      "x-session-id": "s-1",
      "x-amedac-session-id": "s-1",
      "x-amedac-user-id": "7",
      "x-amedac-user-name": encodeURIComponent("Alice 张"),
    });
  });

  it("keeps session headers when the web user is unknown (CLI/subagent)", () => {
    expect(buildMcpIdentityHeaders("s-2")).toEqual({
      "x-session-id": "s-2",
      "x-amedac-session-id": "s-2",
    });
    expect(buildMcpIdentityHeaders(undefined)).toEqual({});
  });

  it("adds the same identifiers to MCP _meta", () => {
    identities.set("s-3", { userId: 42, userName: "bob" });
    expect(buildMcpIdentityMeta("s-3")).toEqual({
      "amedac/session_id": "s-3",
      "amedac/user_id": 42,
      "amedac/user_name": "bob",
    });
    expect(buildMcpRequestMeta("s-3", { traceId: "t" })).toEqual({
      traceId: "t",
      "amedac/session_id": "s-3",
      "amedac/user_id": 42,
      "amedac/user_name": "bob",
    });
  });

  it("preserves caller meta and tolerates a missing/foreign registry", () => {
    delete (globalThis as Record<PropertyKey, unknown>)[KEY];
    expect(readPiWebSessionIdentity("s-4")).toBeUndefined();
    expect(buildMcpRequestMeta("s-4", { traceId: "t" })).toEqual({
      traceId: "t",
      "amedac/session_id": "s-4",
    });
    expect(buildMcpRequestMeta(undefined, { traceId: "t" })).toEqual({ traceId: "t" });
  });
});
