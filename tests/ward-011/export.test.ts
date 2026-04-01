/**
 * Ward 011 — Export Engine Tests
 *
 * Tests PLY header generation, deleted-splat filtering, binary serialization,
 * round-trip correctness, chunked streaming, download signaling, progress,
 * and edge cases (all-deleted).
 *
 * Export contract:
 * - Header declares exact count of non-deleted splats
 * - Binary section contains only active splats in original property order
 * - Streaming: data is flushed in chunks, sink.close() called exactly once
 * - Round-trip: import → delete → export → re-import = correct subset
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
import {
  triggerDownload,
} from "../../src/export/download.js";

// ─── Shared Constants ────────────────────────────────────────────

const VISIBLE = 0x01;
const DELETED = 0x04;

// ─── Helpers ─────────────────────────────────────────────────────

/** Standard 3DGS properties: x, y, z, opacity (4 × f32 = 16 bytes stride) */
const TEST_PROPERTIES: PropertyDef[] = [
  { name: "x", type: "float" },
  { name: "y", type: "float" },
  { name: "z", type: "float" },
  { name: "opacity", type: "float" },
];

/** Build test splat data: 5 splats, simple sequential values */
function makeTestData() {
  const positions = new Float32Array([
    1, 2, 3,
    4, 5, 6,
    7, 8, 9,
    10, 11, 12,
    13, 14, 15,
  ]);
  const opacities = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
  const visibility = new Uint8Array([VISIBLE, VISIBLE, DELETED, VISIBLE, DELETED]);
  // Active: indices 0, 1, 3 (count = 3)

  return { positions, opacities, visibility, totalCount: 5 };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 011: Export Engine", () => {

  // ─── Test 1: export_header_correct ────────────────────────────

  describe("generatePlyHeader", () => {
    it("should produce a PLY header with correct active vertex count", () => {
      const { visibility } = makeTestData();

      const header = generatePlyHeader(TEST_PROPERTIES, visibility);

      expect(header).toContain("ply");
      expect(header).toContain("format binary_little_endian 1.0");
      expect(header).toContain("element vertex 3"); // 5 total - 2 deleted = 3
      expect(header).toContain("property float x");
      expect(header).toContain("property float y");
      expect(header).toContain("property float z");
      expect(header).toContain("property float opacity");
      expect(header).toContain("end_header");
      expect(header).not.toContain("element vertex 5");
    });
  });

  // ─── Test 2: export_excludes_deleted ──────────────────────────

  describe("serializeSplats excludes deleted", () => {
    it("should not include deleted splats in binary output", () => {
      const { positions, opacities, visibility } = makeTestData();
      const data = { positions, opacities };

      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);

      // 3 active splats × 16 bytes stride = 48 bytes
      expect(binary.byteLength).toBe(48);

      const f32 = new Float32Array(binary);
      const xValues = [f32[0], f32[4], f32[8]];
      expect(xValues).not.toContain(7);  // splat 2 (deleted)
      expect(xValues).not.toContain(13); // splat 4 (deleted)
    });
  });

  // ─── Test 3: export_includes_all_active ────────────────────────

  describe("serializeSplats includes all active", () => {
    it("should include all non-deleted splats in correct order", () => {
      const { positions, opacities, visibility } = makeTestData();
      const data = { positions, opacities };

      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);
      const f32 = new Float32Array(binary);

      // Splat 0: x=1, y=2, z=3, opacity=0.1
      expect(f32[0]).toBeCloseTo(1);
      expect(f32[1]).toBeCloseTo(2);
      expect(f32[2]).toBeCloseTo(3);
      expect(f32[3]).toBeCloseTo(0.1);

      // Splat 1: x=4, y=5, z=6, opacity=0.2
      expect(f32[4]).toBeCloseTo(4);
      expect(f32[7]).toBeCloseTo(0.2);

      // Splat 3: x=10, y=11, z=12, opacity=0.4
      expect(f32[8]).toBeCloseTo(10);
      expect(f32[11]).toBeCloseTo(0.4);
    });
  });

  // ─── Test 4: export_binary_matches_input (deep round-trip) ────

  describe("Round-trip correctness", () => {
    it("should produce binary where every float matches the active splat data", () => {
      const { positions, opacities, visibility } = makeTestData();
      const data = { positions, opacities };

      const header = generatePlyHeader(TEST_PROPERTIES, visibility);
      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);

      // Parse header vertex count
      const countMatch = header.match(/element vertex (\d+)/);
      expect(countMatch).not.toBeNull();
      const exportedCount = parseInt(countMatch![1], 10);
      expect(exportedCount).toBe(3);

      const stride = TEST_PROPERTIES.length * 4;
      expect(binary.byteLength).toBe(exportedCount * stride);

      // Deep comparison: verify ALL 12 floats (3 splats × 4 properties)
      const f32 = new Float32Array(binary);

      // Expected values for active splats 0, 1, 3:
      const expected = [
        1, 2, 3, 0.1,     // splat 0
        4, 5, 6, 0.2,     // splat 1
        10, 11, 12, 0.4,  // splat 3
      ];

      expect(f32.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(f32[i]).toBeCloseTo(expected[i], 4);
      }
    });
  });

  // ─── Test 5: export_to_opfs_chunked ───────────────────────────

  describe("exportChunked", () => {
    it("should stream header + binary in chunks and call sink.close() exactly once", () => {
      const { positions, opacities, visibility } = makeTestData();
      const data = { positions, opacities };

      const chunks: ArrayBuffer[] = [];
      const sink: ExportSink = {
        write: vi.fn((chunk: ArrayBuffer) => { chunks.push(chunk); }),
        close: vi.fn(),
      };

      // Small chunk size to force multiple writes
      exportChunked(TEST_PROPERTIES, data, visibility, sink, 32);

      // At least 2 chunks (header + binary)
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // First chunk is PLY header
      const headerText = new TextDecoder().decode(chunks[0]);
      expect(headerText).toContain("ply");
      expect(headerText).toContain("end_header");

      // Total binary bytes = 48 (3 splats × 16)
      const totalBinaryBytes = chunks.slice(1).reduce((sum, c) => sum + c.byteLength, 0);
      expect(totalBinaryBytes).toBe(48);

      // sink.close() called exactly once at the end
      expect(sink.close).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Test 6: export_download_triggers ──────────────────────────

  describe("triggerDownload", () => {
    it("should create a Blob and signal download with filename", () => {
      const mockLink = {
        href: "",
        download: "",
        click: vi.fn(),
      };
      vi.stubGlobal("document", {
        createElement: vi.fn(() => mockLink),
      });
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn(),
      });

      const data = new ArrayBuffer(48);
      triggerDownload(data, "vsplat_export.ply");

      expect(document.createElement).toHaveBeenCalledWith("a");
      expect(mockLink.download).toBe("vsplat_export.ply");
      expect(mockLink.href).toBe("blob:mock-url");
      expect(mockLink.click).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });
  });

  // ─── Test 7: export_progress_callback ─────────────────────────

  describe("Export progress", () => {
    it("should fire progress in [0, 1] range, monotonically increasing to 1.0", () => {
      const { positions, opacities, visibility } = makeTestData();
      const data = { positions, opacities };

      const progressValues: number[] = [];
      const sink: ExportSink = {
        write() {},
        close() {},
      };

      exportChunked(TEST_PROPERTIES, data, visibility, sink, 16, (p) => {
        progressValues.push(p);
      });

      // All values in [0, 1]
      for (const p of progressValues) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }

      // First update >= 0
      expect(progressValues[0]).toBeGreaterThanOrEqual(0);

      // Monotonically increasing
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
      }

      // Final = 1.0
      expect(progressValues[progressValues.length - 1]).toBeCloseTo(1.0);

      // At least 2 updates
      expect(progressValues.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Test 8: export_empty_if_all_deleted ───────────────────────

  describe("Export with all splats deleted", () => {
    it("should produce a valid PLY with 0 vertices and 0 bytes binary", () => {
      const positions = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      const opacities = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const visibility = new Uint8Array([DELETED, DELETED, DELETED, DELETED, DELETED]);
      const data = { positions, opacities };

      // Header says 0 vertices
      const header = generatePlyHeader(TEST_PROPERTIES, visibility);
      expect(header).toContain("element vertex 0");

      // Binary is empty
      const binary = serializeSplats(TEST_PROPERTIES, data, visibility);
      expect(binary.byteLength).toBe(0);

      // Chunked export still completes with progress reaching 1.0
      const progressValues: number[] = [];
      const sink: ExportSink = {
        write: vi.fn(),
        close: vi.fn(),
      };
      exportChunked(TEST_PROPERTIES, data, visibility, sink, 32, (p) => {
        progressValues.push(p);
      });

      expect(progressValues[progressValues.length - 1]).toBeCloseTo(1.0);
      expect(sink.close).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Test 9: mixed_property_types ──────────────────────────────

  describe("Mixed property types (uchar)", () => {
    it("should serialize uchar properties with correct 1-byte stride", () => {
      // Given: properties with mixed types — float x + uchar red
      // Stride = 4 (float) + 1 (uchar) = 5 bytes per splat
      const mixedProps: PropertyDef[] = [
        { name: "x", type: "float" },
        { name: "red", type: "uchar" },
      ];

      const positions = new Float32Array([1, 0, 0, 4, 0, 0]); // 2 splats
      const opacities = new Float32Array([0, 0]);
      const red = new Float32Array([128, 255]); // uchar values stored as float, truncated on write
      const visibility = new Uint8Array([VISIBLE, VISIBLE]);
      const data = { positions, opacities, red };

      // When: we serialize
      const binary = serializeSplats(mixedProps, data, visibility);

      // Then: 2 splats × 5 bytes = 10 bytes (NOT 2 × 8 = 16)
      expect(binary.byteLength).toBe(10);

      // Verify values via DataView
      const dv = new DataView(binary);
      // Splat 0: x=1.0 (float LE at offset 0), red=128 (uchar at offset 4)
      expect(dv.getFloat32(0, true)).toBeCloseTo(1.0);
      expect(dv.getUint8(4)).toBe(128);

      // Splat 1: x=4.0 (float LE at offset 5), red=255 (uchar at offset 9)
      expect(dv.getFloat32(5, true)).toBeCloseTo(4.0);
      expect(dv.getUint8(9)).toBe(255);
    });

    it("should throw if a custom property data array is too short", () => {
      const mixedProps: PropertyDef[] = [
        { name: "x", type: "float" },
        { name: "red", type: "uchar" },
      ];

      const positions = new Float32Array([1, 0, 0, 4, 0, 0]);
      const opacities = new Float32Array([0, 0]);
      // "red" array has only 1 element but we have 2 splats
      const red = new Float32Array([128]);
      const visibility = new Uint8Array([VISIBLE, VISIBLE]);
      const data = { positions, opacities, red };

      expect(() => serializeSplats(mixedProps, data, visibility)).toThrow(/red.*too small/i);
    });
  });
});
