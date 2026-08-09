import { deflateSync } from "node:zlib";
import type { AnnotatedImage } from "@apature/mcp-types";
import type { EvidenceProvider } from "./evidence.js";

/**
 * A deterministic, offline `EvidenceProvider` for the local server and the tests.
 *
 * It is NOT a screenshot and never claims to be: there is no browser in this
 * repository. It encodes a real, valid PNG — a flat placeholder swatch with a
 * border, whose colour is derived from the evidence id — so the multimedia path
 * (`buildMultimediaCritiqueContent` -> MCP `image` content blocks) can be exercised
 * end to end with genuine image bytes rather than a stub. What a host renders is a
 * placeholder standing exactly where the engine's annotated crop would have been.
 *
 * Pure, dependency-free (node:zlib only), and byte-identical for the same id.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (PNG/zlib polynomial), computed without a lookup-table dependency. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Stable 24-bit colour for an id, kept dark enough for a white border to read. */
function colorFor(seed: string): [number, number, number] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  return [80 + (hash & 0x7f), 80 + ((hash >>> 8) & 0x7f), 80 + ((hash >>> 16) & 0x7f)];
}

/**
 * Encode a `width` x `height` truecolour PNG: a solid `seed`-derived fill with a
 * 4px light border. Returns real PNG bytes any decoder accepts.
 */
export function renderPlaceholderPng(seed: string, width = 240, height = 135): Buffer {
  const [r, g, b] = colorFor(seed);
  const border = 4;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // PNG filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const onBorder = x < border || y < border || x >= width - border || y >= height - border;
      const px = rowStart + 1 + x * 3;
      raw[px] = onBorder ? 0xe8 : r;
      raw[px + 1] = onBorder ? 0xe8 : g;
      raw[px + 2] = onBorder ? 0xe8 : b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Offline evidence provider: one deterministic placeholder PNG per requested
 * evidence id. Used by the local server (`local-server.ts`) and the tests so the
 * multimedia surface is reachable with no capture service and no network.
 */
export class SyntheticEvidenceProvider implements EvidenceProvider {
  async forReview(
    _reviewId: string,
    evidenceIds: readonly string[],
  ): Promise<readonly AnnotatedImage[]> {
    return evidenceIds.map((evidenceId) => ({
      evidenceId,
      data: renderPlaceholderPng(evidenceId).toString("base64"),
      mimeType: "image/png",
    }));
  }
}
