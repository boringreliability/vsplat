/**
 * Ward 020 — Point Cloud Render Pipeline.
 *
 * Minimal point-list rendering pipeline der erstatter Ward 19's tunge splat-stack.
 * Vertex shader transformerer XYZ til clip-space; fragment returnerer konstant hvid
 * (Ward 22 introducerer intensity → color ramp). Hardware Z-buffer håndterer
 * synlighed — ingen alpha-blending, ingen radix-sort i hot path.
 *
 * Pipelinen bevarer en `radixSort`-callback i render-pass-API'en, så
 * `RENDER_MODE = "splats"`-grenen kan fortsætte med at dispatche sortering
 * indtil Epic 07 fjerner splat-modet endeligt.
 */

export interface PointPipeline {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
  bindGroupLayout: GPUBindGroupLayout;
}

export type RenderMode = "points" | "splats";

export const RENDER_MODE_POINTS: RenderMode = "points";
export const RENDER_MODE_SPLATS: RenderMode = "splats";

export interface PointRenderPassOptions {
  mode: RenderMode;
  pointCount: number;
  colorView: GPUTextureView;
  depthView: GPUTextureView;
  bindGroup: GPUBindGroup;
  radixSort: { dispatch: (...args: unknown[]) => void };
}

const POINT_SHADER_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
};

@group(0) @binding(0)
var<storage, read> splat_positions: array<f32>;

// Placeholder orthographic projection: maps world z ∈ [-1, 1] → clip z ∈ [0, 1].
// Ward 23 vil erstatte denne hardcoded matrix med en uniform fra CameraSystem.
const VIEW_PROJ = mat4x4f(
  vec4f(1.0, 0.0, 0.0, 0.0),
  vec4f(0.0, 1.0, 0.0, 0.0),
  vec4f(0.0, 0.0, 0.5, 0.0),
  vec4f(0.0, 0.0, 0.5, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let base = vertex_index * 3u;
  let world_pos = vec4f(
    splat_positions[base],
    splat_positions[base + 1u],
    splat_positions[base + 2u],
    1.0,
  );
  var out: VertexOutput;
  out.position = VIEW_PROJ * world_pos;
  return out;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

export async function compilePointPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): Promise<PointPipeline> {
  const shaderModule = device.createShaderModule({
    code: POINT_SHADER_WGSL,
    label: "point-shader",
  });

  // WebGPU spec renamed `compilationInfo()` → `getCompilationInfo()` (Chrome 119+).
  // Vi understøtter begge navne for at virke både i ny browser og i mock-baseret test.
  const sm = shaderModule as GPUShaderModule & {
    getCompilationInfo?: () => Promise<GPUCompilationInfo>;
    compilationInfo?: () => Promise<GPUCompilationInfo>;
  };
  const getInfo = sm.getCompilationInfo ?? sm.compilationInfo;
  if (!getInfo) {
    throw new Error("GPUShaderModule has neither getCompilationInfo nor compilationInfo");
  }
  const info = await getInfo.call(sm);
  const errors = info.messages.filter(
    (m: { type: string }) => m.type === "error",
  );
  if (errors.length > 0) {
    const details = errors.map((e: { message: string }) => e.message).join("; ");
    throw new Error(`Point shader compilation failed: ${details}`);
  }

  const bindGroupLayout = device.createBindGroupLayout({
    label: "point-bind-group-layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "point-pipeline-layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "point-render-pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: {
      topology: "point-list",
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  } as GPURenderPipelineDescriptor);

  return { pipeline, shaderModule, bindGroupLayout };
}

export function encodePointRenderPass(
  encoder: GPUCommandEncoder,
  pipeline: PointPipeline,
  options: PointRenderPassOptions,
): void {
  if (options.mode === RENDER_MODE_SPLATS) {
    options.radixSort.dispatch();
  }

  const pass = encoder.beginRenderPass({
    label: "point-render-pass",
    colorAttachments: [
      {
        view: options.colorView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: options.depthView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });

  pass.setPipeline(pipeline.pipeline);
  pass.setBindGroup(0, options.bindGroup);
  pass.draw(options.pointCount);
  pass.end();
}
