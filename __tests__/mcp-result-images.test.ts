import { describe, expect, it } from "vitest";
import { resolveMcpResult } from "../tool-registrar.ts";
import { imageIdForBase64 } from "../inline-images.ts";

const PNG = "QUJD";
const ID = imageIdForBase64(PNG);

describe("resolveMcpResult image normalization", () => {
  it("maps a standard ImageContent block and rewrites the server marker to a stable id", () => {
    const result = resolveMcpResult({
      content: [
        { type: "text", text: `如图 [[image:arch-1|架构图]] 所示` },
        {
          type: "image",
          data: PNG,
          mimeType: "image/png",
          annotations: { audience: ["user"] },
          _meta: { "amedac/imageId": "arch-1", "amedac/alt": "系统架构图" },
        },
        { type: "text", text: "结束" },
      ],
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: `如图 [[image:${ID}|架构图]] 所示`,
    });
    expect(result.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(result.content[2]).toEqual({ type: "text", text: "结束" });
    expect(result.images).toEqual([{ id: ID, mimeType: "image/png", bytes: 3, alt: "系统架构图" }]);
  });

  it("inserts a marker for an unannounced image block", () => {
    const result = resolveMcpResult({
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
    });

    expect(result.content[0]).toEqual({ type: "text", text: `[[image:${ID}|image]]\n\n` });
    expect(result.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
  });

  it("extracts a legacy markdown data URI into a marker plus image block", () => {
    const result = resolveMcpResult({
      content: [{ type: "text", text: `前 ![shot](data:image/png;base64,${PNG}) 后` }],
    });

    expect(result.content[0]).toEqual({ type: "text", text: `前 [[image:${ID}|shot]] 后` });
    expect(result.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(result.images[0]?.id).toBe(ID);
  });

  it("converts an image EmbeddedResource blob without materializing a temp file", () => {
    const result = resolveMcpResult({
      content: [
        {
          type: "resource",
          resource: { uri: "mcp://shot.png", mimeType: "image/png", blob: PNG },
        },
      ],
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`[[image:${ID}`) });
    expect(result.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(result.images).toHaveLength(1);
  });

  it("keeps a single image entry when the same image appears twice", () => {
    const result = resolveMcpResult({
      content: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    });
    expect(result.images).toHaveLength(1);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
  });
});
