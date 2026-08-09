import { describe, expect, it } from "vitest";
import { renderPlaceholderPng, SyntheticEvidenceProvider } from "../src/synthetic-evidence.js";

/**
 * The offline evidence provider must emit REAL image bytes, not a stub string:
 * the multimedia path only admits `image/*` blocks, and a host that cannot decode
 * what we sent is worse than no image at all. These assertions decode the header
 * the way a renderer would.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("renderPlaceholderPng", () => {
  it("emits a valid PNG signature, IHDR geometry, and an IEND terminator", () => {
    const png = renderPlaceholderPng("shot_001", 240, 135);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(135);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // truecolour
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("is deterministic per id and different across ids", () => {
    expect(renderPlaceholderPng("a").equals(renderPlaceholderPng("a"))).toBe(true);
    expect(renderPlaceholderPng("a").equals(renderPlaceholderPng("b"))).toBe(false);
  });
});

describe("SyntheticEvidenceProvider", () => {
  it("returns one image/png per requested evidence id, in order", async () => {
    const images = await new SyntheticEvidenceProvider().forReview("rev_1", ["shot_001", "shot_002"]);
    expect(images.map((i) => i.evidenceId)).toEqual(["shot_001", "shot_002"]);
    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data, "base64").subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    }
  });

  it("returns nothing when a review has no evidence refs", async () => {
    expect(await new SyntheticEvidenceProvider().forReview("rev_1", [])).toEqual([]);
  });
});
