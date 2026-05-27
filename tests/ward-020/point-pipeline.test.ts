/**
 * Ward 020 — The Point Cloud Shader & Pipeline Clean
 *
 * Tester at den nye point-rendering pipeline:
 *   - bruger `point-list` topologi (ingen quads, ingen UV-falloff)
 *   - har depth-stencil attachment med `depth24plus` og `less` compare
 *   - kompilerer rent (ingen WGSL-errors fra mock)
 *   - bypasser radix-sort dispatch i "points"-mode
 *   - bevarer radix-sort dispatch i "splats"-mode (regression-gate)
 *   - binder kun `splat-positions` (ingen SH eller opacity buffers)
 *   - clearer depth til 1.0 ved hver render pass
 *
 * WebGPU er browser-only — vi mocker GPUDevice, GPUBuffer, GPURenderPipeline
 * og render-pass for at teste pipeline-konstruktion + render-loop call patterns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  compilePointPipeline,
  type PointPipeline,
} from "../../src/webgpu/point-pipeline.js";
import {
  encodePointRenderPass,
  RENDER_MODE_POINTS,
  RENDER_MODE_SPLATS,
  type RenderMode,
} from "../../src/webgpu/point-pipeline.js";

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

// ─── Mock Infrastructure ────────────────────────────────────────

interface PipelineDescriptorCapture {
  label?: string;
  primitive?: { topology?: string };
  depthStencil?: {
    format?: string;
    depthWriteEnabled?: boolean;
    depthCompare?: string;
  };
  fragment?: { targets?: { format?: string; blend?: unknown }[] };
  layout?: unknown;
  vertex?: unknown;
}

interface BindGroupLayoutDescriptorCapture {
  label?: string;
  entries: { binding: number; visibility: number; buffer?: { type?: string } }[];
}

interface RenderPassDescriptorCapture {
  colorAttachments: {
    view: unknown;
    clearValue?: { r: number; g: number; b: number; a: number };
    loadOp?: string;
    storeOp?: string;
  }[];
  depthStencilAttachment?: {
    view: unknown;
    depthClearValue?: number;
    depthLoadOp?: string;
    depthStoreOp?: string;
  };
}

let pipelineDescriptors: PipelineDescriptorCapture[] = [];
let bindGroupLayoutDescriptors: BindGroupLayoutDescriptorCapture[] = [];
let renderPassDescriptors: RenderPassDescriptorCapture[] = [];

class MockGPUShaderModule {
  code: string;
  private errors: { type: string; message: string }[];
  constructor(
    descriptor: { code: string },
    errors: { type: string; message: string }[] = [],
  ) {
    this.code = descriptor.code;
    this.errors = errors;
  }
  async compilationInfo() {
    return { messages: this.errors };
  }
}

function createMockDevice(
  shaderErrors: { type: string; message: string }[] = [],
): GPUDevice {
  return {
    createShaderModule: vi.fn((desc: { code: string }) => {
      return new MockGPUShaderModule(desc, shaderErrors);
    }),
    createRenderPipeline: vi.fn((desc: PipelineDescriptorCapture) => {
      pipelineDescriptors.push(desc);
      return {
        label: desc.label ?? "mock-point-pipeline",
        getBindGroupLayout: vi.fn(() => ({ label: "auto-bgl" })),
      };
    }),
    createBindGroupLayout: vi.fn((desc: BindGroupLayoutDescriptorCapture) => {
      bindGroupLayoutDescriptors.push(desc);
      return { label: desc.label ?? "bgl" };
    }),
    createPipelineLayout: vi.fn(() => ({ label: "layout" })),
    createBindGroup: vi.fn(() => ({ label: "bind-group" })),
    createBuffer: vi.fn(() => ({ size: 0, usage: 0, destroy: vi.fn() })),
    createTexture: vi.fn(() => ({
      createView: vi.fn(() => ({ label: "depth-view" })),
      destroy: vi.fn(),
    })),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

interface MockRenderPass {
  setPipeline: ReturnType<typeof vi.fn>;
  setBindGroup: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createMockEncoder(): {
  encoder: GPUCommandEncoder;
  passes: MockRenderPass[];
} {
  const passes: MockRenderPass[] = [];
  const encoder = {
    beginRenderPass: vi.fn((desc: RenderPassDescriptorCapture) => {
      renderPassDescriptors.push(desc);
      const pass: MockRenderPass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      };
      passes.push(pass);
      return pass;
    }),
    finish: vi.fn(() => ({ label: "cmd-buffer" })),
  } as unknown as GPUCommandEncoder;
  return { encoder, passes };
}

interface RadixSortStub {
  dispatch: ReturnType<typeof vi.fn>;
}

function createRadixSortStub(): RadixSortStub {
  return { dispatch: vi.fn() };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Ward 020: The Point Cloud Shader & Pipeline Clean", () => {
  let device: GPUDevice;

  beforeEach(() => {
    pipelineDescriptors = [];
    bindGroupLayoutDescriptors = [];
    renderPassDescriptors = [];
    device = createMockDevice();
  });

  // ─── T1: point_pipeline_uses_point_list_topology ──────────────

  it("T1: point pipeline uses point-list topology", async () => {
    await compilePointPipeline(device, "bgra8unorm");
    expect(pipelineDescriptors.length).toBeGreaterThanOrEqual(1);
    const desc = pipelineDescriptors[0]!;
    expect(desc.primitive?.topology).toBe("point-list");
  });

  // ─── T2: point_pipeline_has_depth_stencil_attached ────────────

  it("T2: point pipeline has depth-stencil attached with depth24plus + less compare", async () => {
    await compilePointPipeline(device, "bgra8unorm");
    const desc = pipelineDescriptors[0]!;
    expect(desc.depthStencil).toBeDefined();
    expect(desc.depthStencil?.format).toBe("depth24plus");
    expect(desc.depthStencil?.depthWriteEnabled).toBe(true);
    expect(desc.depthStencil?.depthCompare).toBe("less");
  });

  // ─── T3: point_shader_compiles_without_errors ─────────────────

  it("T3: point shader compiles without errors", async () => {
    // Default mock returns empty messages array — no errors expected
    const result = await compilePointPipeline(device, "bgra8unorm");
    expect(result.pipeline).toBeDefined();
    expect(result.shaderModule).toBeDefined();
  });

  it("T3b: point shader compilation surfaces shader errors", async () => {
    const errorDevice = createMockDevice([
      { type: "error", message: "WGSL: unexpected token" },
    ]);
    await expect(compilePointPipeline(errorDevice, "bgra8unorm")).rejects.toThrow(
      /unexpected token/,
    );
  });

  // ─── T4: render_mode_points_bypasses_radix_dispatch ──────────

  it("T4: 'points' render mode does NOT call radixSort.dispatch", async () => {
    const pipeline = await compilePointPipeline(device, "bgra8unorm");
    const { encoder } = createMockEncoder();
    const radixSort = createRadixSortStub();

    encodePointRenderPass(encoder, pipeline, {
      mode: RENDER_MODE_POINTS,
      pointCount: 142_000,
      colorView: { label: "color-view" } as unknown as GPUTextureView,
      depthView: { label: "depth-view" } as unknown as GPUTextureView,
      bindGroup: { label: "bg" } as unknown as GPUBindGroup,
      radixSort,
    });

    expect(radixSort.dispatch).not.toHaveBeenCalled();
  });

  // ─── T5: render_mode_splats_still_calls_radix_dispatch ───────

  it("T5: 'splats' render mode preserves radixSort.dispatch (regression gate)", async () => {
    const pipeline = await compilePointPipeline(device, "bgra8unorm");
    const { encoder } = createMockEncoder();
    const radixSort = createRadixSortStub();

    encodePointRenderPass(encoder, pipeline, {
      mode: RENDER_MODE_SPLATS,
      pointCount: 142_000,
      colorView: { label: "color-view" } as unknown as GPUTextureView,
      depthView: { label: "depth-view" } as unknown as GPUTextureView,
      bindGroup: { label: "bg" } as unknown as GPUBindGroup,
      radixSort,
    });

    expect(radixSort.dispatch).toHaveBeenCalledTimes(1);
  });

  // ─── T6: point_vertex_shader_uses_xyz_only ────────────────────

  it("T6: point pipeline bind group layout exposes only splat-positions (no SH, no opacity)", async () => {
    await compilePointPipeline(device, "bgra8unorm");
    // Vi forventer at compilePointPipeline kalder createBindGroupLayout med
    // præcis ÉN buffer-binding (positions storage). Ingen SH-coefficients, ingen opacity.
    expect(bindGroupLayoutDescriptors.length).toBeGreaterThanOrEqual(1);
    const layout = bindGroupLayoutDescriptors[0]!;
    const bufferEntries = layout.entries.filter((e) => e.buffer !== undefined);
    expect(bufferEntries.length).toBe(1);
    expect(bufferEntries[0]!.binding).toBe(0);
    // Vertex stage skal være tilladt (positions læses i vertex shader)
    expect(bufferEntries[0]!.visibility & GPUShaderStage.VERTEX).toBeTruthy();
  });

  // ─── T7: render_pass_clears_depth_to_1 ────────────────────────

  it("T7: render pass clears depth attachment to 1.0 with depthLoadOp='clear'", async () => {
    const pipeline = await compilePointPipeline(device, "bgra8unorm");
    const { encoder } = createMockEncoder();
    const radixSort = createRadixSortStub();

    encodePointRenderPass(encoder, pipeline, {
      mode: RENDER_MODE_POINTS,
      pointCount: 100,
      colorView: { label: "color" } as unknown as GPUTextureView,
      depthView: { label: "depth" } as unknown as GPUTextureView,
      bindGroup: { label: "bg" } as unknown as GPUBindGroup,
      radixSort,
    });

    expect(renderPassDescriptors.length).toBe(1);
    const passDesc = renderPassDescriptors[0]!;
    expect(passDesc.depthStencilAttachment).toBeDefined();
    expect(passDesc.depthStencilAttachment?.depthClearValue).toBe(1.0);
    expect(passDesc.depthStencilAttachment?.depthLoadOp).toBe("clear");
  });
});
