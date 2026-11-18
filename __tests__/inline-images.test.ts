import { describe, expect, it } from "vitest";
import { extractInlineImages, imageIdForBase64 } from "../inline-images.ts";

const PNG = "QUJD";

describe("extractInlineImages", () => {
  it("replaces a markdown data-URI image with a stable marker", () => {
    const result = extractInlineImages(`before ![shot](data:image/png;base64,${PNG}) after`);
    const id = imageIdForBase64(PNG);

    expect(result.text).toBe(`before [[image:${id}|shot]] after`);
    expect(result.images).toEqual([
      { id, data: PNG, mimeType: "image/png", alt: "shot", bytes: 3 },
    ]);
  });

  it("replaces a bare data URI and keeps the surrounding text", () => {
    const result = extractInlineImages(`图：data:image/jpeg;base64,${PNG}。`);
    expect(result.text).toMatch(/^图：\[\[image:img_[a-f0-9]{16}\|image\]\]。$/);
    expect(result.images[0]).toMatchObject({ mimeType: "image/jpeg", bytes: 3 });
  });

  it("replaces an HTML img tag", () => {
    const result = extractInlineImages(`<img alt="diagram" src="data:image/webp;base64,${PNG}">`);
    expect(result.text).toMatch(/^\[\[image:img_[a-f0-9]{16}\|diagram\]\]$/);
    expect(result.images[0]).toMatchObject({ mimeType: "image/webp" });
  });

  it("leaves fenced code and inline code untouched", () => {
    const fenced = `\`\`\`md\n![x](data:image/png;base64,${PNG})\n\`\`\``;
    const inline = `use \`data:image/png;base64,${PNG}\` here`;
    expect(extractInlineImages(fenced).text).toBe(fenced);
    expect(extractInlineImages(inline).text).toBe(inline);
  });

  it("does not touch malformed base64", () => {
    const text = "data:image/png;base64,not-base64!";
    expect(extractInlineImages(text).text).toBe(text);
    expect(extractInlineImages(text).images).toEqual([]);
  });

  it("omits unsupported formats and oversized payloads instead of echoing base64", () => {
    const svg = `![x](data:image/svg+xml;base64,${PNG})`;
    expect(extractInlineImages(svg).text).toBe("[image omitted: unsupported image type]");

    const big = `![x](data:image/png;base64,${"A".repeat(400)})`;
    const result = extractInlineImages(big, { maxBytes: 10 });
    expect(result.text).toMatch(/^\[image omitted: image\/png, \d+ B\]$/);
    expect(result.images).toEqual([]);
  });

  it("deduplicates repeated images by content id", () => {
    const uri = `data:image/png;base64,${PNG}`;
    const result = extractInlineImages(`one ${uri} two ![same](${uri})`);
    expect(result.images).toHaveLength(1);
    expect(result.text.match(/\[\[image:/g)).toHaveLength(2);
  });
});
