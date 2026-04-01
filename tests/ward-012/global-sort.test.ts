/**
 * Ward 012 — Global GPU Radix Sort Tests
 *
 * Two test categories with distinct verification claims:
 *
 * Category A: Oracle Contract Tests
 *   Verify that the CPU reference (Ward 6) produces correct results.
 *   These do NOT verify Ward 12's GPU implementation. They exist because
 *   Ward 12 depends on the oracle being correct.
 *
 * Category B: Orchestration Tests
 *   Verify that radix-sort-global.ts creates correct buffers, dispatches
 *   correct passes, and wires correct bind groups. They prove architecture
 *   and contracts, not GPU-side numerical correctness.
 *
 * What these tests do NOT prove:
 *   - GPU numerical correctness (requires real WebGPU — Ward 17)
 *   - WGSL shader correctness (race conditions, atomics — Ward 17)
 *   - Render pipeline integration (Ward 16+)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  radixSortIndices,
  floatToSortableUint,
} from "../../src/webgpu/radix-sort-cpu.js";
import {
  createGlobalSortBuffers,
  createGlobalSortPipelines,
  encodeSortGlobal,
  WORKGROUP_SIZE,
  type GlobalSortBuffers,
  type GlobalSortPipelines,
} from "../../src/webgpu/radix-sort-global.js";

// ─── WebGPU Stubs ────────────────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
  UNIFORM: 0x0040,
});

vi.stubGlobal("GPUShaderStage", {
  COMPUTE: 0x4,
});

// ─── Mock Infrastructure ─────────────────────────────────────────

let computePassCount = 0;
let bindGroupCalls: unknown[][] = [];

function createMockComputePass() {
  return {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
}

function createMockCommandEncoder() {
  return {
    beginComputePass: vi.fn(() => {
      computePassCount++;
      return createMockComputePass();
    }),
    finish: vi.fn(() => ({ label: "cmd" })),
  };
}

function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => ({
      size: desc.size, usage: desc.usage, label: desc.label ?? "",
    })),
    createShaderModule: vi.fn((desc: { code: string }) => ({
      code: desc.code,
      compilationInfo: async () => ({ messages: [] }),
    })),
    createComputePipeline: vi.fn(() => ({
      label: "mock-pipeline",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-layout" })),
    })),
    createBindGroup: vi.fn((...args: unknown[]) => {
      bindGroupCalls.push(args);
      return { label: "bind-group", _args: args };
    }),
    queue: {
      writeBuffer: vi.fn(),
    },
  } as unknown as GPUDevice;
}

// ─── Category A: Oracle Contract Tests ───────────────────────────

describe("Ward 012: Global GPU Radix Sort", () => {
  let mockDevice: GPUDevice;

  beforeEach(() => {
    mockDevice = createMockGPUDevice();
    computePassCount = 0;
    bindGroupCalls = [];
  });

  describe("Category A: Oracle Contract Tests", () => {

    // ─── A1: cpu_oracle_100k_correctness ──────────────────────────

    it("A1: CPU oracle produces correct descending order for 100K random elements", () => {
      const count = 100_000;
      const sortKeys = new Float32Array(count);
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sortKeys[i] = Math.random() * 1000 - 500;
        indices[i] = i;
      }

      const sorted = radixSortIndices(sortKeys, indices);

      // Descending order (back-to-front)
      for (let i = 1; i < count; i++) {
        expect(sortKeys[sorted[i - 1]]).toBeGreaterThanOrEqual(sortKeys[sorted[i]]);
      }

      // Permutation check: every original index appears exactly once
      const seen = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        seen[sorted[i]] = 1;
      }
      for (let i = 0; i < count; i++) {
        expect(seen[i]).toBe(1);
      }
    });

    // ─── A2: cpu_oracle_negative_depths ────────────────────────────

    it("A2: CPU oracle handles mixed positive/negative floats correctly", () => {
      const sortKeys = new Float32Array([
        -100, 50, -0.001, 0.001, 999, -999, 0, -0,
      ]);
      const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);

      const sorted = radixSortIndices(sortKeys, indices);

      // Back-to-front: largest first
      for (let i = 1; i < sorted.length; i++) {
        expect(sortKeys[sorted[i - 1]]).toBeGreaterThanOrEqual(sortKeys[sorted[i]]);
      }

      // 999 is farthest → first
      expect(sorted[0]).toBe(4);
      // -999 is closest → last
      expect(sorted[sorted.length - 1]).toBe(5);

      // Verify floatToSortableUint ordering across sign boundary
      expect(floatToSortableUint(-0.001)).toBeLessThan(floatToSortableUint(0.001));
      expect(floatToSortableUint(-999)).toBeLessThan(floatToSortableUint(-100));
    });

    // ─── A3: cpu_oracle_stability ──────────────────────────────────

    it("A3: 1000 equal-key elements preserve original index order", () => {
      // 1000 > WORKGROUP_SIZE(256): proves stability across workgroup boundaries
      const count = 1000;
      const sortKeys = new Float32Array(count).fill(42.0);
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;

      const sorted = radixSortIndices(sortKeys, indices);

      for (let i = 0; i < count; i++) {
        expect(sorted[i]).toBe(i);
      }
    });

    // ─── A4: cpu_oracle_1m_performance ─────────────────────────────

    it("A4: CPU reference sorts 1M elements in under 200ms", () => {
      const count = 1_000_000;
      const sortKeys = new Float32Array(count);
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sortKeys[i] = Math.random() * 2000 - 1000;
        indices[i] = i;
      }

      const start = performance.now();
      const sorted = radixSortIndices(sortKeys, indices);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(200);
      expect(sorted.length).toBe(count);
    });
  });

  // ─── Category B: Orchestration Tests ───────────────────────────

  describe("Category B: Orchestration Tests", () => {

    // ─── B1: histogram_buffer_sizing ──────────────────────────────

    it("B1: createGlobalSortBuffers allocates correctly sized buffers", () => {
      const splatCount = 100_000;
      const numWorkgroups = Math.ceil(splatCount / WORKGROUP_SIZE);

      const buffers = createGlobalSortBuffers(mockDevice, splatCount);

      // Histogram: numWorkgroups × 16 buckets × 4 bytes (column-major)
      const histCall = vi.mocked(mockDevice.createBuffer).mock.calls.find(
        (c) => c[0].label === "sort-histogram",
      );
      expect(histCall).toBeDefined();
      expect(histCall![0].size).toBe(numWorkgroups * 16 * 4);
      expect(histCall![0].usage & GPUBufferUsage.STORAGE).toBeTruthy();

      // ScanAux: ceil(numWorkgroups * 16 / WORKGROUP_SIZE) × 4 bytes
      const scanAuxCall = vi.mocked(mockDevice.createBuffer).mock.calls.find(
        (c) => c[0].label === "sort-scan-aux",
      );
      expect(scanAuxCall).toBeDefined();
      const expectedScanAuxSize = Math.ceil((numWorkgroups * 16) / WORKGROUP_SIZE) * 4;
      expect(scanAuxCall![0].size).toBe(expectedScanAuxSize);

      // Double-buffered index buffers
      const idxCalls = vi.mocked(mockDevice.createBuffer).mock.calls.filter(
        (c) => c[0].label?.startsWith("sort-indices"),
      );
      expect(idxCalls.length).toBe(2);
      expect(idxCalls[0][0].size).toBe(splatCount * 4);
      expect(idxCalls[1][0].size).toBe(splatCount * 4);

      // Params: 16 bytes (count + shift + numWorkgroups + pad)
      const paramsCall = vi.mocked(mockDevice.createBuffer).mock.calls.find(
        (c) => c[0].label === "sort-params",
      );
      expect(paramsCall).toBeDefined();
      expect(paramsCall![0].size).toBe(16);

      expect(buffers.splatCount).toBe(splatCount);
    });

    // ─── B2: three_pass_dispatch_count ─────────────────────────────

    it("B2: encodeSortGlobal dispatches 3 passes per radix pass (≥24 total)", async () => {
      const splatCount = 10_000;
      const buffers = createGlobalSortBuffers(mockDevice, splatCount);
      const pipelines = await createGlobalSortPipelines(mockDevice);
      const encoder = createMockCommandEncoder();

      encodeSortGlobal(
        mockDevice,
        encoder as unknown as GPUCommandEncoder,
        pipelines,
        buffers,
      );

      // 8 radix passes × 3 dispatches = 24 minimum.
      // Multi-level scan may add more. Must be at least 24.
      expect(computePassCount).toBeGreaterThanOrEqual(24);
    });

    // ─── B3: params_uniform_contents ──────────────────────────────

    it("B3: writeBuffer for params contains [count, shift, numWorkgroups, 0]", async () => {
      const splatCount = 10_000;
      const numWorkgroups = Math.ceil(splatCount / WORKGROUP_SIZE);
      const buffers = createGlobalSortBuffers(mockDevice, splatCount);
      const pipelines = await createGlobalSortPipelines(mockDevice);
      const encoder = createMockCommandEncoder();

      // Record params writes
      const paramsWrites: { count: number; shift: number; numWg: number; pad: number }[] = [];
      vi.mocked(mockDevice.queue.writeBuffer).mockImplementation(
        (_buf: GPUBuffer, _off: number, data: ArrayBufferView | ArrayBuffer) => {
          const u32 = new Uint32Array(
            data instanceof ArrayBuffer ? data : data.buffer,
            data instanceof ArrayBuffer ? 0 : data.byteOffset,
          );
          if (u32.length >= 4) {
            paramsWrites.push({
              count: u32[0], shift: u32[1], numWg: u32[2], pad: u32[3],
            });
          }
        },
      );

      encodeSortGlobal(mockDevice, encoder as unknown as GPUCommandEncoder, pipelines, buffers);

      // 8 radix passes → 8 params writes
      expect(paramsWrites.length).toBe(8);

      for (let pass = 0; pass < 8; pass++) {
        expect(paramsWrites[pass].count).toBe(splatCount);
        expect(paramsWrites[pass].shift).toBe(pass * 4); // 4-bit radix
        expect(paramsWrites[pass].numWg).toBe(numWorkgroups);
        expect(paramsWrites[pass].pad).toBe(0);
      }
    });

    // ─── B4: histogram_bind_group_wiring ──────────────────────────

    it("B4: all three passes reference the histogram buffer in bind groups", async () => {
      const splatCount = 1_000;
      const buffers = createGlobalSortBuffers(mockDevice, splatCount);
      const pipelines = await createGlobalSortPipelines(mockDevice);
      const encoder = createMockCommandEncoder();

      encodeSortGlobal(mockDevice, encoder as unknown as GPUCommandEncoder, pipelines, buffers);

      // Find all bind groups that reference the histogram buffer
      const histogramRefs = bindGroupCalls.filter((args) => {
        const desc = args[0] as { entries?: { resource?: { buffer?: unknown } }[] };
        return desc.entries?.some((e) => e.resource?.buffer === buffers.histogram);
      });

      // Count, Scan, and Scatter all reference histogram — at least 3 per radix pass
      // 8 passes × 3 = 24 minimum histogram references
      expect(histogramRefs.length).toBeGreaterThanOrEqual(24);
    });

    // ─── B5: scan_aux_buffer_wiring ───────────────────────────────

    it("B5: scan pass bind group includes the auxiliary buffer", async () => {
      const splatCount = 10_000;
      const buffers = createGlobalSortBuffers(mockDevice, splatCount);
      const pipelines = await createGlobalSortPipelines(mockDevice);
      const encoder = createMockCommandEncoder();

      encodeSortGlobal(mockDevice, encoder as unknown as GPUCommandEncoder, pipelines, buffers);

      // Find bind groups that reference scanAux
      const auxRefs = bindGroupCalls.filter((args) => {
        const desc = args[0] as { entries?: { resource?: { buffer?: unknown } }[] };
        return desc.entries?.some((e) => e.resource?.buffer === buffers.scanAux);
      });

      // scanAux must be referenced by scan passes (at least once per radix pass)
      expect(auxRefs.length).toBeGreaterThanOrEqual(8);
    });

    // ─── B6: ping_pong_final_in_indicesA ──────────────────────────

    it("B6: encodeSortGlobal returns buffers.indicesA after 8 passes (even)", async () => {
      const splatCount = 1_000;
      const buffers = createGlobalSortBuffers(mockDevice, splatCount);
      const pipelines = await createGlobalSortPipelines(mockDevice);
      const encoder = createMockCommandEncoder();

      const result = encodeSortGlobal(
        mockDevice,
        encoder as unknown as GPUCommandEncoder,
        pipelines,
        buffers,
      );

      // After 8 passes (even number of swaps), result is in indicesA
      expect(result).toBe(buffers.indicesA);
    });
  });
});
