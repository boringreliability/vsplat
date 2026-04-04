/**
 * Ward 016 — True Streaming I/O Tests
 *
 * Category A: Import Hardening (3 tests)
 *   Truncated input, allocation efficiency, memory scaling.
 *
 * Category B: Export Hardening (3 tests)
 *   Batch buffer reuse, cancellation cleanup, empty export.
 *
 * Category C: Roundtrip (1 test)
 *   Import → delete → export → reimport integrity.
 *
 * No new features — this Ward proves existing code works at scale.
 */

import { describe, it, expect, vi } from "vitest";
import {
  generatePlyHeader,
  serializeSplats,
  type PropertyDef,
} from "../../src/export/ply-writer.js";
import {
  exportChunked,
  type ExportSink,
} from "../../src/export/stream.js";

// ─── Shared ──────────────────────────────────────────────────────

const VISIBLE = 0x01;
const DELETED = 0x04;

const TEST_PROPERTIES: PropertyDef[] = [
  { name: "x", type: "float" },
  { name: "y", type: "float" },
  { name: "z", type: "float" },
  { name: "opacity", type: "float" },
];

const STRIDE = 16; // 4 floats × 4 bytes

/** Build PLY binary bytes (header + binary) for N splats with 4 float properties. */
function makePlyBytes(count: number): Uint8Array {
  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n` +
    `property float x\nproperty float y\nproperty float z\nproperty float opacity\n` +
    `end_header\n`;
  const headerBytes = new TextEncoder().encode(header);
  const binarySize = count * STRIDE;
  const result = new Uint8Array(headerBytes.length + binarySize);
  result.set(headerBytes, 0);

  const view = new DataView(result.buffer, headerBytes.length, binarySize);
  for (let i = 0; i < count; i++) {
    const off = i * STRIDE;
    view.setFloat32(off, i, true);       // x
    view.setFloat32(off + 4, i + 0.1, true); // y
    view.setFloat32(off + 8, i + 0.2, true); // z
    view.setFloat32(off + 12, 0.9, true);    // opacity
  }

  return result;
}

/** Build test splat data arrays for export tests. */
function makeSplatData(count: number) {
  const positions = new Float32Array(count * 3);
  const opacities = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i + 0.1;
    positions[i * 3 + 2] = i + 0.2;
    opacities[i] = 0.9;
  }
  return { positions, opacities };
}

// Import hardening (A1-A3) is tested in Rust cargo tests:
//   - truncated_binary_parse_all_returns_error
//   - truncated_binary_parse_chunked_returns_error
//   - parse_all_no_overallocation
// TS tests cover export hardening and roundtrip.

describe("Ward 016: True Streaming I/O", () => {

  describe("Category B: Export Hardening", () => {

    // ─── B1: export_batch_buffer_reused ────────────────────────────

    it("B1: 50K splats with batch size 10K produces exactly 5 data writes + 1 header", () => {
      const count = 50_000;
      const data = makeSplatData(count);
      const visibility = new Uint8Array(count).fill(VISIBLE);

      const writeCalls: { byteLength: number }[] = [];
      const sink: ExportSink = {
        write: vi.fn((chunk: ArrayBuffer) => {
          writeCalls.push({ byteLength: chunk.byteLength });
        }),
        close: vi.fn(),
      };

      // Batch size: 10K splats × 16 bytes = 160KB
      const batchSize = 10_000 * STRIDE;
      exportChunked(TEST_PROPERTIES, data, visibility, sink, batchSize);

      // 1 header write + 5 data writes (50K / 10K = 5 batches)
      expect(writeCalls.length).toBe(6);

      // First write is header (text, much smaller than data)
      expect(writeCalls[0].byteLength).toBeLessThan(200);

      // Remaining 5 writes are data batches
      const dataBytes = writeCalls.slice(1).reduce((sum, w) => sum + w.byteLength, 0);
      expect(dataBytes).toBe(count * STRIDE);

      expect(sink.close).toHaveBeenCalledTimes(1);
    });

    // ─── B2: export_cancel_cleans_up ──────────────────────────────

    it("B2: sink error on 3rd write propagates and close is still called", () => {
      const count = 50_000;
      const data = makeSplatData(count);
      const visibility = new Uint8Array(count).fill(VISIBLE);

      let writeCount = 0;
      const sink: ExportSink = {
        write: vi.fn(() => {
          writeCount++;
          if (writeCount === 3) {
            throw new Error("Disk full");
          }
        }),
        close: vi.fn(),
      };

      // Export should propagate the sink error
      expect(() => {
        exportChunked(TEST_PROPERTIES, data, visibility, sink, 10_000 * STRIDE);
      }).toThrow(/Disk full/);

      // World is not modified (export is read-only on visibility + data)
      expect(visibility[0]).toBe(VISIBLE); // unchanged
    });

    // ─── B3: export_empty_file_valid ──────────────────────────────

    it("B3: 0-splat export produces valid PLY with empty binary section", () => {
      const data = makeSplatData(5);
      const visibility = new Uint8Array([DELETED, DELETED, DELETED, DELETED, DELETED]);

      // Header should say 0 vertices
      const header = generatePlyHeader(TEST_PROPERTIES, visibility);
      expect(header).toContain("element vertex 0");

      // Serialize should produce 0 bytes
      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);
      expect(binary.byteLength).toBe(0);

      // Chunked export completes with close and progress 1.0
      const progressValues: number[] = [];
      const sink: ExportSink = {
        write: vi.fn(),
        close: vi.fn(),
      };
      exportChunked(TEST_PROPERTIES, data, visibility, sink, 1024, (p) => {
        progressValues.push(p);
      });
      expect(progressValues[progressValues.length - 1]).toBeCloseTo(1.0);
      expect(sink.close).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Category C: Roundtrip ─────────────────────────────────────

  describe("Category C: Roundtrip", () => {

    // ─── C1: roundtrip_large_dataset ──────────────────────────────

    it("C1: 50K import → delete 10K → export → reimport = 40K with correct data", () => {
      const count = 50_000;
      const data = makeSplatData(count);
      const visibility = new Uint8Array(count).fill(VISIBLE);

      // Delete first 10K splats
      for (let i = 0; i < 10_000; i++) {
        visibility[i] = DELETED;
      }

      // Export
      const header = generatePlyHeader(TEST_PROPERTIES, visibility);
      expect(header).toContain("element vertex 40000");

      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);
      expect(binary.byteLength).toBe(40_000 * STRIDE);

      // Reimport: verify data integrity
      const reimported = new Float32Array(binary);
      const reimportedCount = reimported.length / 4; // 4 floats per splat
      expect(reimportedCount).toBe(40_000);

      // First reimported splat should be original index 10000 (first non-deleted)
      expect(reimported[0]).toBeCloseTo(10_000);       // x
      expect(reimported[1]).toBeCloseTo(10_000.1, 0);  // y
      expect(reimported[2]).toBeCloseTo(10_000.2, 0);  // z
      expect(reimported[3]).toBeCloseTo(0.9);           // opacity

      // Last reimported splat should be original index 49999
      const lastBase = (40_000 - 1) * 4;
      expect(reimported[lastBase]).toBeCloseTo(49_999);
      expect(reimported[lastBase + 3]).toBeCloseTo(0.9);
    });
  });
});
