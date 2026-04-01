/**
 * Ward 006 — Radix Sort Compute Shader Tests
 *
 * Tests depth calculation, float-to-uint bit manipulation, radix sort logic,
 * stability, buffer management, and pipeline setup for GPU-accelerated
 * back-to-front sorting.
 *
 * Since WebGPU compute shaders can't run in Node, we test:
 * - JS reference implementations of the sort algorithm
 * - Bit-level correctness of float→sortable-uint conversion
 * - Correct buffer allocation and pipeline setup
 * - WGSL shader code structure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeDepths,
  floatToSortableUint,
  radixSortIndices,
} from "../../src/webgpu/radix-sort-cpu.js";
import {
  createSortBuffers,
  createSortPipeline,
  encodeSort,
  type SortBuffers,
  type SortPipeline,
} from "../../src/webgpu/radix-sort-gpu.js";

// ─── WebGPU Constant Stubs ──────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
});

vi.stubGlobal("GPUShaderStage", {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
});

// ─── Mock Infrastructure ─────────────────────────────────────────

class MockGPUBuffer {
  size: number;
  usage: number;
  label: string;

  constructor(desc: { size: number; usage: number; label?: string }) {
    this.size = desc.size;
    this.usage = desc.usage;
    this.label = desc.label ?? "";
  }

  destroy() {}
}

class MockGPUShaderModule {
  code: string;
  compilationInfo = async () => ({ messages: [] as never[] });

  constructor(desc: { code: string }) {
    this.code = desc.code;
  }
}

/** Tracks compute passes created by mock encoder */
let computePasses: ReturnType<typeof createMockComputePass>[] = [];

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
      const pass = createMockComputePass();
      computePasses.push(pass);
      return pass;
    }),
    finish: vi.fn(() => ({ label: "command-buffer" })),
  };
}

function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => {
      return new MockGPUBuffer(desc);
    }),
    createShaderModule: vi.fn((desc: { code: string }) => {
      return new MockGPUShaderModule(desc);
    }),
    createComputePipeline: vi.fn(() => ({
      label: "mock-compute-pipeline",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-layout" })),
    })),
    createBindGroupLayout: vi.fn(() => ({ label: "bind-group-layout" })),
    createPipelineLayout: vi.fn(() => ({ label: "pipeline-layout" })),
    createBindGroup: vi.fn((...args: unknown[]) => ({ label: "bind-group", args })),
    createCommandEncoder: vi.fn(() => createMockCommandEncoder()),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 006: Radix Sort Compute Shader", () => {
  let mockDevice: GPUDevice;

  beforeEach(() => {
    computePasses = [];
    mockDevice = createMockGPUDevice();
  });

  // ─── Test 1: depth_calculation_correct ────────────────────────

  describe("computeDepths", () => {
    it("should calculate correct sortKeys from camera position", () => {
      // Given: 4 splats at known positions and a camera looking down -Z
      // sortKey = dot(viewDir, pos - cameraPos)
      // Larger sortKey = farther from camera = rendered first (back-to-front)
      const positions = new Float32Array([
        0, 0, -5,  // splat 0: directly ahead, sortKey 5
        0, 0, -2,  // splat 1: close, sortKey 2
        0, 0, -10, // splat 2: far, sortKey 10
        1, 1, -5,  // splat 3: offset but same Z, sortKey 5
      ]);
      const cameraPos: [number, number, number] = [0, 0, 0];
      const viewDir: [number, number, number] = [0, 0, -1];

      // When: we compute sortKeys
      const { sortKeys, indices } = computeDepths(positions, cameraPos, viewDir);

      // Then: sortKeys are correct (dot product of viewDir with pos - camera)
      expect(sortKeys.length).toBe(4);
      expect(sortKeys[0]).toBeCloseTo(5);   // -(-5) dotted with [0,0,-1] = 5
      expect(sortKeys[1]).toBeCloseTo(2);
      expect(sortKeys[2]).toBeCloseTo(10);
      expect(sortKeys[3]).toBeCloseTo(5);

      // Indices are initialized as identity
      expect(indices).toEqual(new Uint32Array([0, 1, 2, 3]));
    });
  });

  // ─── Test 1b-1e: float_to_sortable_uint ───────────────────────

  describe("floatToSortableUint", () => {
    it("should preserve relative order of positive floats", () => {
      const a = floatToSortableUint(1.0);
      const b = floatToSortableUint(2.0);
      const c = floatToSortableUint(100.5);
      const d = floatToSortableUint(1e10);

      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(c).toBeLessThan(d);
    });

    it("should preserve relative order of negative floats", () => {
      const a = floatToSortableUint(-10.0);
      const b = floatToSortableUint(-5.0);
      const c = floatToSortableUint(-1.0);

      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
    });

    it("should place all negative floats below all positive floats in uint space", () => {
      const negLarge = floatToSortableUint(-1e-30);
      const posSmall = floatToSortableUint(1e-30);

      expect(negLarge).toBeLessThan(posSmall);

      const negHuge = floatToSortableUint(-1e30);
      expect(negHuge).toBeLessThan(posSmall);
    });

    it("should handle +0.0 and -0.0 consistently", () => {
      const posZero = floatToSortableUint(+0.0);
      const negZero = floatToSortableUint(-0.0);

      expect(Math.abs(posZero - negZero)).toBeLessThanOrEqual(1);

      const posSmall = floatToSortableUint(1e-30);
      expect(posZero).toBeLessThan(posSmall);
    });
  });

  // ─── Test 2: radix_sort_small_array ───────────────────────────

  describe("radixSortIndices (small)", () => {
    it("should correctly sort 1K elements by depth (back-to-front)", () => {
      const count = 1000;
      const sortKeys = new Float32Array(count);
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sortKeys[i] = Math.random() * 100;
        indices[i] = i;
      }

      const sorted = radixSortIndices(sortKeys, indices);

      for (let i = 1; i < count; i++) {
        expect(sortKeys[sorted[i - 1]]).toBeGreaterThanOrEqual(sortKeys[sorted[i]]);
      }
    });
  });

  // ─── Test 3: radix_sort_large_array ───────────────────────────

  describe("radixSortIndices (large with edge cases)", () => {
    it("should correctly sort 100K elements including extremes and duplicates", () => {
      const count = 100_000;
      const sortKeys = new Float32Array(count);
      const indices = new Uint32Array(count);

      for (let i = 0; i < count; i++) {
        indices[i] = i;
      }

      for (let i = 0; i < 80_000; i++) {
        sortKeys[i] = Math.random() * 1000 - 500;
      }
      for (let i = 80_000; i < 85_000; i++) {
        sortKeys[i] = (Math.random() > 0.5 ? 1 : -1) * (1e20 + Math.random() * 1e20);
      }
      for (let i = 85_000; i < 95_000; i++) {
        sortKeys[i] = 42.0;
      }
      for (let i = 95_000; i < count; i++) {
        sortKeys[i] = (Math.random() - 0.5) * 1e-10;
      }

      const sorted = radixSortIndices(sortKeys, indices);

      for (let i = 1; i < count; i++) {
        expect(sortKeys[sorted[i - 1]]).toBeGreaterThanOrEqual(sortKeys[sorted[i]]);
      }
    });
  });

  // ─── Test 4: sort_stability ───────────────────────────────────

  describe("sort stability", () => {
    it("should preserve original order for equal depths", () => {
      const sortKeys = new Float32Array([5.0, 3.0, 5.0, 1.0, 5.0, 3.0, 7.0, 7.0]);
      const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);

      const sorted = radixSortIndices(sortKeys, indices);

      const key7 = Array.from(sorted).filter(i => sortKeys[i] === 7.0);
      expect(key7).toEqual([6, 7]);

      const key5 = Array.from(sorted).filter(i => sortKeys[i] === 5.0);
      expect(key5).toEqual([0, 2, 4]);

      const key3 = Array.from(sorted).filter(i => sortKeys[i] === 3.0);
      expect(key3).toEqual([1, 5]);
    });
  });

  // ─── Test 5: sort_performance_budget ──────────────────────────

  describe("sort performance", () => {
    it("should sort 250K elements in under 200ms on CPU reference impl", () => {
      const count = 250_000;
      const sortKeys = new Float32Array(count);
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sortKeys[i] = Math.random() * 1000 - 500;
        indices[i] = i;
      }

      const start = performance.now();
      const sorted = radixSortIndices(sortKeys, indices);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(200);
      expect(sorted.length).toBe(count);
    });
  });

  // ─── Test 6: sort_pipeline_and_buffers_created ────────────────

  describe("createSortPipeline + createSortBuffers", () => {
    it("should create compute pipeline and double-buffered sort buffers", async () => {
      const splatCount = 5_000_000;

      const buffers = createSortBuffers(mockDevice, splatCount);
      const pipeline = await createSortPipeline(mockDevice);

      // Then: sort-key buffer is correctly sized (splatCount × 4 bytes for u32 sortable keys)
      const keyCall = vi.mocked(mockDevice.createBuffer).mock.calls.find(
        (c) => c[0].label === "sort-keys",
      );
      expect(keyCall).toBeDefined();
      expect(keyCall![0].size).toBe(splatCount * 4);
      expect(keyCall![0].usage & GPUBufferUsage.STORAGE).toBeTruthy();

      // Then: TWO index buffers for ping-pong/double-buffering
      const idxCalls = vi.mocked(mockDevice.createBuffer).mock.calls.filter(
        (c) => c[0].label?.startsWith("sort-indices"),
      );
      expect(idxCalls.length).toBe(2);
      expect(idxCalls[0][0].size).toBe(splatCount * 4);
      expect(idxCalls[1][0].size).toBe(splatCount * 4);
      expect(idxCalls[0][0].usage & GPUBufferUsage.STORAGE).toBeTruthy();
      expect(idxCalls[1][0].usage & GPUBufferUsage.STORAGE).toBeTruthy();

      // Then: params uniform buffer (8 bytes: count u32 + shift u32)
      const paramsCall = vi.mocked(mockDevice.createBuffer).mock.calls.find(
        (c) => c[0].label === "sort-params",
      );
      expect(paramsCall).toBeDefined();
      expect(paramsCall![0].size).toBe(8);
      expect(paramsCall![0].usage & GPUBufferUsage.UNIFORM).toBeTruthy();
      expect(paramsCall![0].usage & GPUBufferUsage.COPY_DST).toBeTruthy();

      // Compute pipeline with @compute and @workgroup_size WGSL
      expect(mockDevice.createComputePipeline).toHaveBeenCalled();
      expect(mockDevice.createShaderModule).toHaveBeenCalled();
      const shaderCode = vi.mocked(mockDevice.createShaderModule).mock.calls[0][0].code;
      expect(shaderCode).toContain("@compute");
      expect(shaderCode).toContain("@workgroup_size");

      expect(buffers.splatCount).toBe(splatCount);
      expect(pipeline).toBeDefined();
    });
  });

  // ─── Test 7: encodeSort_orchestrates_4_passes_correctly ───────

  describe("encodeSort", () => {
    it("should orchestrate 4 radix passes with correct params and ping-pong", async () => {
      // Given: a pipeline, buffers for 1024 splats, and a command encoder
      const splatCount = 1024;
      const buffers = createSortBuffers(mockDevice, splatCount);
      const pipeline = await createSortPipeline(mockDevice);
      const encoder = createMockCommandEncoder();

      // Set up recording mock for writeBuffer BEFORE calling encodeSort
      const recordedParams: { count: number; shift: number }[] = [];
      vi.mocked(mockDevice.queue.writeBuffer).mockImplementation(
        (_buf: GPUBuffer, _off: number, data: ArrayBufferView | ArrayBuffer) => {
          const u32 = new Uint32Array(
            data instanceof ArrayBuffer ? data : data.buffer,
            data instanceof ArrayBuffer ? 0 : data.byteOffset,
            2,
          );
          recordedParams.push({ count: u32[0], shift: u32[1] });
        },
      );

      // When: we encode the sort
      const result = encodeSort(mockDevice, encoder as unknown as GPUCommandEncoder, pipeline, buffers);

      // Then: writeBuffer was called 4 times with shift 0, 8, 16, 24
      expect(recordedParams.length).toBe(4);
      expect(recordedParams[0]).toEqual({ count: splatCount, shift: 0 });
      expect(recordedParams[1]).toEqual({ count: splatCount, shift: 8 });
      expect(recordedParams[2]).toEqual({ count: splatCount, shift: 16 });
      expect(recordedParams[3]).toEqual({ count: splatCount, shift: 24 });

      // Then: createBindGroup was called 4 times with ping-pong buffers
      const bindCalls = vi.mocked(mockDevice.createBindGroup).mock.calls;
      expect(bindCalls.length).toBe(4);

      const getBindingBuffer = (passIdx: number, bindingIdx: number) => {
        const entries = (bindCalls[passIdx][0] as { entries: { binding: number; resource: { buffer: unknown } }[] }).entries;
        return entries.find(e => e.binding === bindingIdx)?.resource.buffer;
      };

      // binding 0 is always sortKeys
      expect(getBindingBuffer(0, 0)).toBe(buffers.sortKeys);
      expect(getBindingBuffer(1, 0)).toBe(buffers.sortKeys);

      // binding 1 (read) and binding 2 (write) alternate (ping-pong)
      expect(getBindingBuffer(0, 1)).toBe(buffers.indicesA); // pass 0: read A
      expect(getBindingBuffer(0, 2)).toBe(buffers.indicesB); // pass 0: write B
      expect(getBindingBuffer(1, 1)).toBe(buffers.indicesB); // pass 1: read B
      expect(getBindingBuffer(1, 2)).toBe(buffers.indicesA); // pass 1: write A
      expect(getBindingBuffer(2, 1)).toBe(buffers.indicesA); // pass 2: read A
      expect(getBindingBuffer(2, 2)).toBe(buffers.indicesB); // pass 2: write B
      expect(getBindingBuffer(3, 1)).toBe(buffers.indicesB); // pass 3: read B
      expect(getBindingBuffer(3, 2)).toBe(buffers.indicesA); // pass 3: write A

      // binding 3 is always params
      expect(getBindingBuffer(0, 3)).toBe(buffers.params);

      // Then: 4 compute passes were dispatched
      expect(computePasses.length).toBe(4);
      const expectedWorkgroups = Math.ceil(splatCount / 256);
      for (const pass of computePasses) {
        expect(pass.setPipeline).toHaveBeenCalledWith(pipeline.pipeline);
        expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(expectedWorkgroups);
        expect(pass.end).toHaveBeenCalled();
      }

      // Then: returns indicesA (result after 4 passes = even number of swaps)
      expect(result).toBe(buffers.indicesA);
    });
  });
});
