// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpContent, ContentBlock, McpImageInfo } from "./types.ts";
import { extractInlineImages, imageIdForBase64, normalizeInlineImageMime } from "./inline-images.ts";

const MAX_BINARY_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_RESOURCE_BYTES = 100 * 1024 * 1024;
const MAX_SESSION_RESOURCE_FILES = 10_000; // Bounds metadata from empty or tiny resources.
const CLEANUP_RETRY_DELAY_MS = 30_000;
const MAX_CLEANUP_RETRY_ATTEMPTS = 3;
type MaterializedResourceSession = {
  directory: string | undefined;
  bytes: number;
  files: number;
  sequence: number;
};

function createMaterializedResourceSession(): MaterializedResourceSession {
  return {
    directory: undefined,
    bytes: 0,
    files: 0,
    sequence: 0,
  };
}

const defaultMaterializedResourceSession = createMaterializedResourceSession();
const scopedMaterializedResourceSessions = new WeakMap<object, MaterializedResourceSession>();
const pendingCleanupDirectories = new Set<string>();
const cleanupRetryAttempts = new Map<string, number>();
let pendingCleanupRetry: ReturnType<typeof setTimeout> | undefined;

function isAbortedScope(scope: object | undefined): boolean {
  return !!scope && "aborted" in scope && (scope as { aborted?: unknown }).aborted === true;
}

function getMaterializedResourceSession(scope?: object): MaterializedResourceSession | undefined {
  if (isAbortedScope(scope)) return undefined;
  if (!scope) return defaultMaterializedResourceSession;
  let session = scopedMaterializedResourceSessions.get(scope);
  if (!session) {
    session = createMaterializedResourceSession();
    scopedMaterializedResourceSessions.set(scope, session);
  }
  return session;
}

type BinaryResource = { uri?: string | undefined; text?: string | undefined; mimeType?: string | undefined; blob: string };
type McpResourceContent = {
  uri: string;
  text?: string | undefined;
  blob?: string | undefined;
  mimeType?: string | undefined;
  [key: string]: unknown;
};

function hasRetryableCleanupDirectory(): boolean {
  for (const directory of pendingCleanupDirectories) {
    if ((cleanupRetryAttempts.get(directory) ?? 0) < MAX_CLEANUP_RETRY_ATTEMPTS) return true;
  }
  return false;
}

function schedulePendingCleanupRetry(): void {
  if (pendingCleanupRetry || !hasRetryableCleanupDirectory()) return;
  for (const directory of pendingCleanupDirectories) {
    const attempts = cleanupRetryAttempts.get(directory) ?? 0;
    if (attempts < MAX_CLEANUP_RETRY_ATTEMPTS) cleanupRetryAttempts.set(directory, attempts + 1);
  }
  pendingCleanupRetry = setTimeout(() => {
    pendingCleanupRetry = undefined;
    try {
      drainPendingCleanupDirectories();
    } catch {
      // drainPendingCleanupDirectories already retained the paths and rescheduled another retry.
    }
  }, CLEANUP_RETRY_DELAY_MS);
}

function drainPendingCleanupDirectories(): void {
  const failures: unknown[] = [];
  for (const directory of Array.from(pendingCleanupDirectories)) {
    try {
      rmSync(directory, { recursive: true, force: true });
      pendingCleanupDirectories.delete(directory);
      cleanupRetryAttempts.delete(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (pendingCleanupDirectories.size === 0 && pendingCleanupRetry) {
    clearTimeout(pendingCleanupRetry);
    pendingCleanupRetry = undefined;
  }
  if (failures.length > 0) {
    schedulePendingCleanupRetry();
    throw new AggregateError(failures, "Failed to clean materialized MCP resources");
  }
}

export function cleanupMaterializedBinaryResources(scope?: object): void {
  const session = scope ? scopedMaterializedResourceSessions.get(scope) : defaultMaterializedResourceSession;
  if (session?.directory) pendingCleanupDirectories.add(session.directory);
  if (session) {
    session.directory = undefined;
    session.bytes = 0;
    session.files = 0;
    session.sequence = 0;
    if (scope) scopedMaterializedResourceSessions.delete(scope);
  }

  drainPendingCleanupDirectories();
}

function replaceBlob(resource: BinaryResource, text: string): string {
  delete (resource as Partial<BinaryResource>).blob;
  resource.text = text;
  return text;
}

function omitBinaryResource(resource: BinaryResource, reason: string): string {
  return replaceBlob(resource, [
    `[Resource: ${resource.uri ?? "(no URI)"}]`,
    `Binary content omitted: ${reason}`,
    `MIME type: ${resource.mimeType ?? "application/octet-stream"}`,
  ].join("\n"));
}

function materializeBinaryResource(resource: BinaryResource, scope?: object): string {
  const session = getMaterializedResourceSession(scope);
  if (!session) return omitBinaryResource(resource, "runtime stopped");
  const decodedBytes = Buffer.byteLength(resource.blob, "base64");
  if (decodedBytes > MAX_BINARY_RESOURCE_BYTES) {
    return omitBinaryResource(resource, "decoded size exceeds 10 MiB");
  }
  if (
    session.bytes + decodedBytes > MAX_SESSION_RESOURCE_BYTES ||
    session.files >= MAX_SESSION_RESOURCE_FILES
  ) {
    return omitBinaryResource(resource, "session resource limit reached");
  }

  try {
    session.directory ??= mkdtempSync(join(tmpdir(), "pi-mcp-resource-"));
  } catch {
    return omitBinaryResource(resource, "could not be saved");
  }

  const filePath = join(session.directory, `resource-${++session.sequence}.bin`);
  session.bytes += decodedBytes;
  session.files += 1;
  try {
    writeFileSync(filePath, Buffer.from(resource.blob, "base64"), { flag: "wx", mode: 0o600 });
  } catch {
    try {
      rmSync(filePath, { force: true });
      session.bytes -= decodedBytes;
      session.files -= 1;
    } catch {
      // Keep the reservation when a partial file cannot be removed.
    }
    return omitBinaryResource(resource, "could not be saved");
  }

  return replaceBlob(resource, [
    `[Resource: ${resource.uri ?? "(no URI)"}]`,
    `Binary content saved to ${filePath}`,
    `MIME type: ${resource.mimeType ?? "application/octet-stream"}`,
  ].join("\n"));
}

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpResourceContents(contents: McpResourceContent[], scope?: object): ContentBlock[] {
  return contents.map(resource => {
    if (typeof resource.text === "string") return { type: "text" as const, text: resource.text };
    if (typeof resource.blob === "string") return { type: "text" as const, text: materializeBinaryResource(resource as BinaryResource, scope) };
    return { type: "text" as const, text: JSON.stringify(resource) };
  });
}

export interface McpResultContent {
  content: ContentBlock[];
  /** Unique images carried by this result; bytes remain in `content`. */
  images: McpImageInfo[];
}

interface ImageEntry {
  info: McpImageInfo;
  data: string;
  mimeType: string;
  alt: string;
  serverId?: string;
}

const MCP_IMAGE_MARKER_RE = /\[\[image:([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
const MARKER_ALT_MAX = 160;

function metaString(content: McpContent, key: string): string | undefined {
  const value = content._meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function markerFor(entry: ImageEntry, altOverride?: string): string {
  const alt = (altOverride || entry.alt)
    .replace(/[|\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MARKER_ALT_MAX);
  return `[[image:${entry.info.id}${alt ? `|${alt}` : ""}]]`;
}

function normalizedBase64(data: string | undefined): { data: string; bytes: number } | null {
  const normalized = (data ?? "").replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return { data: normalized, bytes: Math.floor((normalized.length * 3) / 4) - padding };
}

function imageEntryFromBlock(block: McpContent): ImageEntry | null {
  if (block.type !== "image") return null;
  const mimeType = normalizeInlineImageMime(block.mimeType);
  const decoded = normalizedBase64(block.data);
  if (!mimeType || !decoded) return null;
  const id = imageIdForBase64(decoded.data);
  const alt = metaString(block, "amedac/alt") ?? "image";
  const serverId = metaString(block, "amedac/imageId");
  return {
    info: { id, mimeType, bytes: decoded.bytes, ...(alt !== "image" ? { alt } : {}) },
    data: decoded.data,
    mimeType,
    alt,
    ...(serverId ? { serverId } : {}),
  };
}

function imageEntryFromResource(block: McpContent): ImageEntry | null {
  if (block.type !== "resource" || typeof block.resource?.blob !== "string") return null;
  const mimeType = normalizeInlineImageMime(block.resource.mimeType ?? block.mimeType);
  const decoded = normalizedBase64(block.resource.blob);
  if (!mimeType || !decoded) return null;
  const id = imageIdForBase64(decoded.data);
  const alt = block.resource.uri || block.name || "image";
  const serverId = metaString(block, "amedac/imageId");
  return {
    info: { id, mimeType, bytes: decoded.bytes, alt },
    data: decoded.data,
    mimeType,
    alt,
    ...(serverId ? { serverId } : {}),
  };
}

function pushText(out: ContentBlock[], text: string): void {
  if (text) out.push({ type: "text", text });
}

function pushImageBlock(out: ContentBlock[], entry: ImageEntry, emitted: Set<string>): void {
  if (emitted.has(entry.info.id)) return;
  emitted.add(entry.info.id);
  out.push({ type: "image", data: entry.data, mimeType: entry.mimeType });
}

function pushMarker(out: ContentBlock[], entry: ImageEntry): void {
  const last = out[out.length - 1];
  const prefix = last?.type === "text" && !/\s$/.test(last.text) ? "\n\n" : "";
  out.push({ type: "text", text: `${prefix}${markerFor(entry)}\n\n` });
}

/**
 * Transform MCP content into pi blocks while preserving image positions.
 *
 * Standard `ImageContent` blocks become pi image blocks and get an inline
 * `[[image:id|alt]]` marker when their surrounding text did not already carry
 * one. Legacy data-URI images inside text are extracted first, so the model
 * only sees a short marker instead of hundreds of kilobytes of base64.
 */
export function transformMcpContentWithImages(content: McpContent[], scope?: object): McpResultContent {
  const preparedText = content.map((block) =>
    block.type === "text" ? extractInlineImages(block.text ?? "") : null,
  );
  const entries: ImageEntry[] = [];
  const byId = new Map<string, ImageEntry>();
  const byServerId = new Map<string, ImageEntry>();
  const blockEntries = new Map<number, ImageEntry>();

  const remember = (entry: ImageEntry) => {
    entries.push(entry);
    byId.set(entry.info.id, entry);
    if (entry.serverId) byServerId.set(entry.serverId, entry);
  };

  content.forEach((block, index) => {
    const entry = imageEntryFromBlock(block) ?? imageEntryFromResource(block);
    if (entry) {
      blockEntries.set(index, entry);
      remember(entry);
    }
  });
  for (const prepared of preparedText) {
    if (!prepared) continue;
    for (const inline of prepared.images) {
      if (byId.has(inline.id)) continue;
      remember({
        info: { id: inline.id, mimeType: inline.mimeType, bytes: inline.bytes, alt: inline.alt },
        data: inline.data,
        mimeType: inline.mimeType,
        alt: inline.alt,
      });
    }
  }

  // Images already named by a text marker keep that marker; only unreferenced
  // images get one inserted at their position.
  const referenced = new Set<string>();
  for (const prepared of preparedText) {
    if (!prepared) continue;
    for (const match of prepared.text.matchAll(MCP_IMAGE_MARKER_RE)) {
      if (match[1]) referenced.add(match[1]);
    }
  }

  const out: ContentBlock[] = [];
  const emitted = new Set<string>();
  content.forEach((block, index) => {
    if (block.type === "text") {
      const prepared = preparedText[index]!;
      const text = prepared.text.replace(MCP_IMAGE_MARKER_RE, (_full, markerId: string, alt?: string) => {
        const entry = byServerId.get(markerId) ?? byId.get(markerId);
        if (!entry) return alt?.trim() || `[image missing: ${markerId}]`;
        return markerFor(entry, alt);
      });
      pushText(out, text);
      for (const inline of prepared.images) {
        const entry = byId.get(inline.id);
        if (entry) pushImageBlock(out, entry, emitted);
      }
      return;
    }

    const entry = blockEntries.get(index);
    if (entry) {
      if (!referenced.has(entry.serverId ?? entry.info.id)) pushMarker(out, entry);
      pushImageBlock(out, entry, emitted);
      return;
    }

    if (block.type === "image") {
      // Unsupported/legacy image shape: keep it as a pi image block so the
      // provider can decide; there is no marker because pi-web cannot serve it.
      out.push({
        type: "image" as const,
        data: block.data ?? "",
        mimeType: block.mimeType ?? "image/png",
      });
      return;
    }
    if (block.type === "resource") {
      const resourceUri = block.resource?.uri ?? "(no URI)";
      if (block.resource && "blob" in block.resource && typeof block.resource.blob === "string") {
        const binaryResource = block.resource as typeof block.resource & { mimeType?: string; blob: string };
        pushText(out, materializeBinaryResource(binaryResource, scope));
        return;
      }
      const resourceContent = block.resource?.text ?? (block.resource ? JSON.stringify(block.resource) : "(no content)");
      pushText(out, `[Resource: ${resourceUri}]\n${resourceContent}`);
      return;
    }
    if (block.type === "resource_link") {
      const linkName = block.name ?? block.uri ?? "unknown";
      const linkUri = block.uri ?? "(no URI)";
      pushText(out, `[Resource Link: ${linkName}]\nURI: ${linkUri}`);
      return;
    }
    if (block.type === "audio") {
      pushText(out, `[Audio content: ${block.mimeType ?? "audio/*"}]`);
      return;
    }
    pushText(out, JSON.stringify(block));
  });

  return {
    content: out,
    images: entries
      .filter((entry, index) => entries.findIndex((candidate) => candidate.info.id === entry.info.id) === index)
      .map((entry) => entry.info),
  };
}

export function transformMcpContent(content: McpContent[], scope?: object): ContentBlock[] {
  return transformMcpContentWithImages(content, scope).content;
}

/**
 * Resolve a tool result's content blocks, appending structuredContent when it
 * coexists with ordinary content and falling back to it when content is empty.
 */
export function resolveMcpResult(result: Record<string, unknown>, scope?: object): McpResultContent {
  const transformed = transformMcpContentWithImages(
    (Array.isArray(result.content) ? result.content : []) as McpContent[],
    scope,
  );
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const structured = stringifyStructuredContent(result.structuredContent);
    if (transformed.content.length > 0) {
      return {
        ...transformed,
        content: [...transformed.content, { type: "text" as const, text: `structuredContent:\n${structured}` }],
      };
    }
    return { ...transformed, content: [{ type: "text" as const, text: structured }] };
  }
  return transformed;
}

export function resolveMcpResultContent(result: Record<string, unknown>, scope?: object): ContentBlock[] {
  return resolveMcpResult(result, scope).content;
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
