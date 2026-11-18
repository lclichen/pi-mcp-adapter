/**
 * Legacy inline-image normalization for MCP text results.
 *
 * MCP has a native `ImageContent` block, but several servers still return
 * markdown images with `data:` URIs, bare data URIs, or `<img src="data:...">`
 * inside a TextContent block. The model can only echo short references, so we
 * replace each inline image with a stable `[[image:img_<hash>|alt]]` marker and
 * hand the bytes back as a real image block. The marker is what survives an
 * LLM rewrite; the image block is what the vision model sees.
 *
 * The hash is sha256(normalized base64)[0..16]. pi-web recomputes the same id
 * when it stores the image, so markers and the asset store agree even when the
 * adapter is updated independently.
 */
import { createHash } from "node:crypto";

/** Browser-renderable image types. SVG/TIFF stay text (SVG is a script vector). */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

export interface InlineImage {
  /** Stable content id: `img_` + first 16 hex chars of sha256(base64). */
  id: string;
  data: string;
  mimeType: string;
  alt: string;
  bytes: number;
}

export interface InlineImageResult {
  text: string;
  images: InlineImage[];
}

export interface InlineImageOptions {
  /**
   * Safety ceiling for one inline data URI. This is not a storage limit — it
   * protects the Node event loop from decoding a multi-hundred-MB blob that
   * was pasted into a text result. Oversized images are replaced with a short
   * omission notice instead of being echoed back to the model.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_INLINE_BYTES = 64 * 1024 * 1024;
const MARKER_PREFIX = "[[image:";
const MARKER_ALT_MAX = 160;

export function normalizeInlineImageMime(raw: string | undefined): string | null {
  const lower = (raw ?? "").trim().toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  return INLINE_IMAGE_MIMES.has(lower) ? lower : null;
}

export function imageIdForBase64(data: string): string {
  const normalized = data.replace(/\s+/g, "");
  return `img_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function markerFor(image: InlineImage): string {
  const alt = image.alt.replace(/[|\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, MARKER_ALT_MAX);
  return `${MARKER_PREFIX}${image.id}${alt ? `|${alt}` : ""}]]`;
}

function base64Info(data: string): { normalized: string; bytes: number; padding: number } | null {
  const normalized = data.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return { normalized, bytes: Math.floor((normalized.length * 3) / 4) - padding, padding };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Offsets of fenced code blocks (inclusive of the fence lines). */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: { char: string; length: number; start: number } | null = null;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = match?.[1];
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.length) {
        ranges.push([fence.start, lineStart + line.length]);
        fence = null;
      }
      continue;
    }
    if (marker) fence = { char: marker.charAt(0), length: marker.length, start: lineStart };
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

/** Offsets of inline-code spans (backtick runs) outside fenced blocks. */
function inlineCodeRanges(text: string, fences: Array<[number, number]>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (fences.some(([start, end]) => lineStart >= start && lineStart <= end)) continue;
    const runs: Array<{ start: number; end: number; length: number }> = [];
    for (let i = 0; i < line.length; ) {
      if (line[i] !== "`") {
        i += 1;
        continue;
      }
      let j = i;
      while (j < line.length && line[j] === "`") j += 1;
      runs.push({ start: lineStart + i, end: lineStart + j, length: j - i });
      i = j;
    }
    for (let i = 0; i < runs.length; i += 1) {
      const open = runs[i];
      if (!open) continue;
      const closeIndex = runs.findIndex((run, index) => index > i && run.length === open.length);
      const close = closeIndex === -1 ? undefined : runs[closeIndex];
      if (!close) continue;
      ranges.push([open.start, close.end]);
      i = closeIndex;
    }
  }
  return ranges;
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

interface Replacement {
  start: number;
  end: number;
  text: string;
  image?: InlineImage;
  omitted?: string;
}

function htmlImageAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

/**
 * Replace inline data-URI images with markers. Fenced and inline code are left
 * alone; malformed base64 is left alone; unsupported MIME and oversized blobs
 * become short omission notices so the model never receives a giant payload.
 */
export function extractInlineImages(text: string, options: InlineImageOptions = {}): InlineImageResult {
  if (!text.includes("data:image/")) return { text, images: [] };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const fences = fencedRanges(text);
  const inlineCode = inlineCodeRanges(text, fences);
  const replacements: Replacement[] = [];
  const images = new Map<string, InlineImage>();
  const dataUri = /data:image\/[a-z0-9.+-]+;base64,/gi;

  let match: RegExpExecArray | null;
  while ((match = dataUri.exec(text)) !== null) {
    const start = match.index;
    if (inRanges(start, fences) || inRanges(start, inlineCode)) continue;

    // Find the end of the base64 payload. Markdown/HTML containers give an
    // unambiguous delimiter; a bare URI ends at whitespace or a quote-like
    // delimiter (single-line data URIs are the norm).
    const mime = normalizeInlineImageMime(match[0].slice(5, -8));
    const afterComma = dataUri.lastIndex;
    let payloadEnd = -1;
    let spanStart = start;
    let spanEnd = -1;
    let alt = "";

    // Markdown image: ![alt](data:...)
    const bang = text.lastIndexOf("![", start);
    if (bang >= 0 && text.slice(bang, start).match(/^!\[[^\]\n]*\]\(\s*$/)) {
      const close = text.indexOf(")", afterComma);
      if (close >= 0) {
        const altMatch = /^!\[([^\]\n]*)\]\(/.exec(text.slice(bang, start));
        alt = altMatch?.[1] ?? "";
        spanStart = bang;
        spanEnd = close + 1;
        payloadEnd = close;
      }
    }

    // HTML image: <img ... src="data:...">
    if (spanEnd < 0) {
      const tagStart = text.lastIndexOf("<img", start);
      if (tagStart >= 0 && !text.slice(tagStart, start).includes(">")) {
        const tagEnd = text.indexOf(">", afterComma);
        if (tagEnd >= 0) {
          const tag = text.slice(tagStart, tagEnd + 1);
          if (/src\s*=/i.test(tag)) {
            alt = htmlImageAttribute(tag, "alt") ?? "";
            const quoteOffset = text.slice(afterComma, tagEnd).search(/["']/);
            spanStart = tagStart;
            spanEnd = tagEnd + 1;
            payloadEnd = quoteOffset >= 0 ? afterComma + quoteOffset : tagEnd;
          }
        }
      }
    }

    // Bare data URI: consume base64 characters only. A terminating punctuation
    // (including CJK full stops) is not part of the payload.
    if (spanEnd < 0) {
      let i = afterComma;
      while (i < text.length && /[A-Za-z0-9+/=]/.test(text.charAt(i))) i += 1;
      payloadEnd = i;
      spanEnd = i;
    }

    const rawPayload = text.slice(afterComma, payloadEnd).trim();
    const info = base64Info(rawPayload);
    if (!info) continue;
    if (!mime) {
      // Unsupported vector/format: keep the text short rather than hand the
      // model a giant blob, but do not pretend it is an image we can render.
      replacements.push({ start: spanStart, end: spanEnd, text: "[image omitted: unsupported image type]" });
      dataUri.lastIndex = spanEnd;
      continue;
    }
    if (info.bytes > maxBytes) {
      replacements.push({
        start: spanStart,
        end: spanEnd,
        text: `[image omitted: ${mime}, ${formatBytes(info.bytes)}]`,
      });
      dataUri.lastIndex = spanEnd;
      continue;
    }

    const id = imageIdForBase64(info.normalized);
    const image: InlineImage = {
      id,
      data: info.normalized,
      mimeType: mime,
      alt: alt.trim() || "image",
      bytes: info.bytes,
    };
    images.set(id, image);
    replacements.push({ start: spanStart, end: spanEnd, text: markerFor(image), image });
    dataUri.lastIndex = spanEnd;
  }

  if (replacements.length === 0) return { text, images: [] };
  let output = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }
  return { text: output, images: [...images.values()] };
}
