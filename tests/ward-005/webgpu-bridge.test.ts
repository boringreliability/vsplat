/**
 * Ward 005 — WebGPU Low-Copy Bridge & Basic Render Tests
 *
 * Tests the Wasm memory → GPU buffer bridge, render pipeline setup,
 * render loop, dirty-flag optimisation, and failure paths.
 *
 * Since WebGPU is browser-only, we mock GPUDevice, GPUBuffer, GPUQueue
 * and related interfaces to test our logic in Node.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWasmMemoryView,
  type WasmMemoryView,
} from "../../src/webgpu/wasm-memory.js";
import {
  createGpuSplatBuffer,
  uploadSplatBuffer,
  type GpuSplatBuffer,
} from "../../src/webgpu/gpu-buffer.js";
import {
  compileRenderPipeline,
  type SplatRenderPipeline,
} from "../../src/webgpu/render-pipeline.js";
import {
  createRenderLoop,
  renderFrame,
  type RenderLoop,
} from "../../src/webgpu/render-loop.js";

// ─── WebGPU Constant Stubs ──────────────────────────────────────
// WebGPU enums don't exist in Node. Stub them before any test runs.

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

// ─── WebGPU Mock Infrastructure ──────────────────────────────────

/** Tracks bytes written to mock GPU buffers */
let writtenBufferData: { buffer: MockGPUBuffer; offset: number; data: ArrayBuffer }[] = [];

class MockGPUBuffer {
  size: number;
  usage: number;
  label: string;
  destroyed = false;

  constructor(descriptor: { size: number; usage: number; label?: string }) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.label = descriptor.label ?? "";
  }

  destroy() {
    this.destroyed = true;
  }
}

class MockGPUShaderModule {
  code: string;
  compilationInfo: () => Promise<{ messages: { type: string; message: string }[] }>;

  constructor(descriptor: { code: string }, errorMessages?: { type: string; message: string }[]) {
    this.code = descriptor.code;
    this.compilationInfo = async () => ({
      messages: errorMessages ?? [],
    });
  }
}

class MockGPURenderPipeline {
  label: string;
  constructor(descriptor: { label?: string }) {
    this.label = descriptor.label ?? "mock-pipeline";
  }

  getBindGroupLayout(_index: number) {
    return { label: "auto-bind-group-layout" };
  }
}

class MockGPUCommandEncoder {
  private passes: object[] = [];

  beginRenderPass(_descriptor: unknown) {
    const pass = {
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    this.passes.push(pass);
    return pass;
  }

  finish() {
    return { label: "command-buffer" };
  }
}

function createMockGPUDevice(shaderErrors?: { type: string; message: string }[]): GPUDevice {
  const device = {
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => {
      return new MockGPUBuffer(desc);
    }),
    createShaderModule: vi.fn((desc: { code: string }) => {
      return new MockGPUShaderModule(desc, shaderErrors);
    }),
    createRenderPipeline: vi.fn((desc: { label?: string }) => {
      return new MockGPURenderPipeline(desc);
    }),
    createPipelineLayout: vi.fn(() => ({ label: "layout" })),
    createBindGroupLayout: vi.fn(() => ({ label: "bind-group-layout" })),
    createBindGroup: vi.fn(() => ({ label: "bind-group" })),
    createCommandEncoder: vi.fn(() => new MockGPUCommandEncoder()),
    queue: {
      writeBuffer: vi.fn(
        (buffer: MockGPUBuffer, offset: number, data: ArrayBuffer) => {
          writtenBufferData.push({ buffer, offset, data });
        },
      ),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
  return device;
}

function createMockCanvasContext() {
  return {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({
      createView: vi.fn(() => ({ label: "texture-view" })),
    })),
    canvas: { width: 800, height: 600 },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 005: WebGPU Low-Copy Bridge & Basic Render", () => {
  let mockDevice: GPUDevice;
  let mockContext: ReturnType<typeof createMockCanvasContext>;

  beforeEach(() => {
    writtenBufferData = [];
    mockDevice = createMockGPUDevice();
    mockContext = createMockCanvasContext();
  });

  // ─── Test 1: wasm_memory_view_valid ───────────────────────────

  describe("createWasmMemoryView", () => {
    it("should create a valid Float32Array view of Wasm memory at given pointer and length", () => {
      // Given: a Wasm memory buffer with known data
      const wasmMemory = new ArrayBuffer(1024);
      const f32 = new Float32Array(wasmMemory);
      // Write 3 position floats at byte offset 64 (f32 index 16)
      f32[16] = 1.5; // x
      f32[17] = 2.5; // y
      f32[18] = 3.5; // z

      // When: we create a view at pointer=64, count=3
      const view = createWasmMemoryView(wasmMemory, 64, 3);

      // Then: the view reads the correct values directly from wasm memory
      expect(view.data).toBeInstanceOf(Float32Array);
      expect(view.data.length).toBe(3);
      expect(view.data[0]).toBeCloseTo(1.5);
      expect(view.data[1]).toBeCloseTo(2.5);
      expect(view.data[2]).toBeCloseTo(3.5);
      expect(view.byteOffset).toBe(64);
      expect(view.byteLength).toBe(12); // 3 × 4 bytes
    });

    // ─── Test 1b: wasm_memory_view_boundary_errors ──────────────

    it("should throw if pointer + length exceeds buffer bounds", () => {
      // Given: a 256-byte buffer (64 f32 slots)
      const wasmMemory = new ArrayBuffer(256);

      // When/Then: requesting beyond the end throws
      expect(() => createWasmMemoryView(wasmMemory, 252, 2)).toThrow();
    });

    it("should throw if count is 0 or negative", () => {
      const wasmMemory = new ArrayBuffer(256);

      expect(() => createWasmMemoryView(wasmMemory, 0, 0)).toThrow();
      expect(() => createWasmMemoryView(wasmMemory, 0, -1)).toThrow();
    });

    it("should throw if pointer is not 4-byte aligned", () => {
      const wasmMemory = new ArrayBuffer(256);

      // Byte offset 3 is not aligned to 4 bytes (Float32 requirement)
      expect(() => createWasmMemoryView(wasmMemory, 3, 1)).toThrow();
      expect(() => createWasmMemoryView(wasmMemory, 5, 1)).toThrow();
    });
  });

  // ─── Test 2: gpu_buffer_created ───────────────────────────────

  describe("createGpuSplatBuffer", () => {
    it("should create a GPUBuffer with correct size for splat count", () => {
      // Given: a device and a known splat count
      const splatCount = 5_000_000;
      // positions = 3 floats × 4 bytes = 12 bytes per splat
      const expectedSize = splatCount * 3 * 4;

      // When: we create a splat buffer
      const splatBuffer = createGpuSplatBuffer(mockDevice, splatCount);

      // Then: GPU buffer is created with correct size and usage
      expect(mockDevice.createBuffer).toHaveBeenCalledTimes(1);
      const call = vi.mocked(mockDevice.createBuffer).mock.calls[0][0];
      expect(call.size).toBe(expectedSize);
      // Must have STORAGE and COPY_DST usage (Design B: storage buffer model)
      expect(call.usage & GPUBufferUsage.STORAGE).toBeTruthy();
      expect(call.usage & GPUBufferUsage.COPY_DST).toBeTruthy();
      expect(splatBuffer.splatCount).toBe(splatCount);
    });
  });

  // ─── Test 3: gpu_buffer_data_matches ──────────────────────────

  describe("uploadSplatBuffer", () => {
    it("should upload Float32Array data to GPU buffer via writeBuffer", () => {
      // Given: a wasm memory view with position data
      const wasmMemory = new ArrayBuffer(256);
      const f32 = new Float32Array(wasmMemory);
      // 2 splats: positions [1,2,3] and [4,5,6]
      f32[0] = 1.0;
      f32[1] = 2.0;
      f32[2] = 3.0;
      f32[3] = 4.0;
      f32[4] = 5.0;
      f32[5] = 6.0;

      const view = createWasmMemoryView(wasmMemory, 0, 6);
      const splatBuffer = createGpuSplatBuffer(mockDevice, 2);

      // When: we upload
      uploadSplatBuffer(mockDevice, splatBuffer, view);

      // Then: writeBuffer was called with the view's underlying data
      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
      const writeCall = vi.mocked(mockDevice.queue.writeBuffer).mock.calls[0];
      expect(writeCall[0]).toBe(splatBuffer.buffer);
      expect(writeCall[1]).toBe(0); // offset 0

      // The written data should match our source
      const written = new Float32Array(writeCall[2] as ArrayBuffer);
      expect(written[0]).toBeCloseTo(1.0);
      expect(written[5]).toBeCloseTo(6.0);
    });
  });

  // ─── Test 4: render_pipeline_compiles ─────────────────────────

  describe("compileRenderPipeline", () => {
    it("should create shader module and render pipeline without errors", async () => {
      // Given: a mock device and canvas format
      const format = "bgra8unorm" as GPUTextureFormat;

      // When: we compile the render pipeline
      const pipeline = await compileRenderPipeline(mockDevice, format);

      // Then: shader module was created
      expect(mockDevice.createShaderModule).toHaveBeenCalled();
      const shaderCall = vi.mocked(mockDevice.createShaderModule).mock.calls[0][0];
      // Shader code should contain WGSL markers
      expect(shaderCall.code).toContain("@vertex");
      expect(shaderCall.code).toContain("@fragment");

      // Render pipeline was created
      expect(mockDevice.createRenderPipeline).toHaveBeenCalled();
      expect(pipeline.pipeline).toBeDefined();
    });

    // ─── Test 4b: render_pipeline_shader_error ──────────────────

    it("should throw a descriptive error when shader compilation fails", async () => {
      // Given: a device whose shader module reports a compilation error
      const brokenDevice = createMockGPUDevice([
        { type: "error", message: "expected '(' for function declaration" },
      ]);
      const format = "bgra8unorm" as GPUTextureFormat;

      // When/Then: compiling should throw with the shader error message
      await expect(compileRenderPipeline(brokenDevice, format)).rejects.toThrow(
        /shader.*compilation.*failed|expected '\(' for function declaration/i,
      );
    });
  });

  // ─── Test 5: render_loop_starts ───────────────────────────────

  describe("createRenderLoop", () => {
    it("should start and stop a render loop using requestAnimationFrame", () => {
      // Given: a mock requestAnimationFrame
      let rafCallback: FrameRequestCallback | null = null;
      let rafId = 0;
      vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
        rafCallback = cb;
        return ++rafId;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());

      const renderFn = vi.fn();

      // When: we create and start the loop
      const loop = createRenderLoop(renderFn);
      loop.start();

      // Then: rAF was called
      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

      // Simulate one frame tick
      rafCallback!(16.67);
      expect(renderFn).toHaveBeenCalledTimes(1);

      // Another tick
      rafCallback!(33.33);
      expect(renderFn).toHaveBeenCalledTimes(2);

      // Stop
      loop.stop();
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(loop.isRunning()).toBe(false);
    });
  });

  // ─── Test 6: render_commands_encoded ──────────────────────────

  describe("renderFrame", () => {
    it("should encode render commands with storage buffer bind group", async () => {
      // Given: a compiled pipeline and a splat buffer with 100 splats
      const format = "bgra8unorm" as GPUTextureFormat;
      const pipeline = await compileRenderPipeline(mockDevice, format);
      const splatBuffer = createGpuSplatBuffer(mockDevice, 100);

      // When: we call renderFrame (our function, not manual encoder simulation)
      renderFrame(mockDevice, mockContext as unknown as GPUCanvasContext, pipeline, splatBuffer);

      // Then: a bind group was created binding the storage buffer
      expect(mockDevice.createBindGroup).toHaveBeenCalled();

      // Then: a command encoder was created and submitted
      expect(mockDevice.createCommandEncoder).toHaveBeenCalled();
      expect(mockDevice.queue.submit).toHaveBeenCalled();

      // And: the canvas context was used to get the current texture
      expect(mockContext.getCurrentTexture).toHaveBeenCalled();
    });
  });

  // ─── Test 7: dirty_flag_prevents_unnecessary_upload ────────────

  describe("dirty flag", () => {
    it("should only write to GPU on first call; second call with unchanged data is a no-op", () => {
      // Given: a wasm memory view and a freshly created (dirty) splat buffer
      const wasmMemory = new ArrayBuffer(256);
      const view = createWasmMemoryView(wasmMemory, 0, 6);
      const splatBuffer = createGpuSplatBuffer(mockDevice, 2);

      // When: we upload twice in a row without marking dirty between calls
      uploadSplatBuffer(mockDevice, splatBuffer, view);
      uploadSplatBuffer(mockDevice, splatBuffer, view);

      // Then: writeBuffer was only called once — the function internally
      // checks and resets the dirty flag
      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
    });
  });
});
