/**
 * Ward 022 — Colored Point Pipeline.
 *
 * Parallel pipeline til Ward 20's `compilePointPipeline`. Tilføjer:
 *   - 4 storage bindings (positions, intensity, rgb, classification)
 *   - 1 ramp texture + sampler (FRAGMENT)
 *   - 1 uniform buffer (min, max, mode)
 *
 * Ward 20's pipeline røres ikke — denne lever side-om-side.
 */

export interface ColoredPointPipeline {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
  bindGroupLayout: GPUBindGroupLayout;
}

const COLORED_POINT_SHADER_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) intensity_norm: f32,
  // u32 outputs MUST be flat-interpolated (WGSL spec — integers cannot be linearly
  // interpolated across a primitive). For point-list topology this is moot, but the
  // WGSL validator requires the attribute on all integer locations.
  @location(1) @interpolate(flat) classification: u32,
  @location(2) rgb: vec3f,
};

struct ColorUniform {
  min: f32,
  max: f32,
  mode: u32,
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read> intensities: array<u32>; // u16 values packed 2-per-u32
@group(0) @binding(2) var<storage, read> rgb_buffer: array<u32>;  // RGBA8 packed
@group(0) @binding(3) var<storage, read> classifications: array<u32>; // u8 values packed 4-per-u32
@group(0) @binding(4) var ramp_tex: texture_1d<f32>;
@group(0) @binding(5) var ramp_sampler: sampler;
@group(0) @binding(6) var<uniform> u: ColorUniform;

const VIEW_PROJ = mat4x4f(
  vec4f(1.0, 0.0, 0.0, 0.0),
  vec4f(0.0, 1.0, 0.0, 0.0),
  vec4f(0.0, 0.0, 0.5, 0.0),
  vec4f(0.0, 0.0, 0.5, 1.0),
);

fn read_intensity(idx: u32) -> u32 {
  let word = intensities[idx >> 1u];
  let shift = (idx & 1u) * 16u;
  return (word >> shift) & 0xFFFFu;
}

fn read_classification(idx: u32) -> u32 {
  let word = classifications[idx >> 2u];
  let shift = (idx & 3u) * 8u;
  return (word >> shift) & 0xFFu;
}

fn read_rgb(idx: u32) -> vec3f {
  let packed = rgb_buffer[idx];
  let r = f32(packed & 0xFFu) / 255.0;
  let g = f32((packed >> 8u) & 0xFFu) / 255.0;
  let b = f32((packed >> 16u) & 0xFFu) / 255.0;
  return vec3f(r, g, b);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let base = vi * 3u;
  let wx = positions[base + 0u];
  let wy = positions[base + 1u];
  let wz = positions[base + 2u];

  var out: VertexOutput;
  out.position = VIEW_PROJ * vec4f(wx, wy, wz, 1.0);

  // Compute intensity normalization (used in mode 0)
  let raw_intensity = f32(read_intensity(vi));
  out.intensity_norm = clamp((raw_intensity - u.min) / max(u.max - u.min, 1.0e-6), 0.0, 1.0);

  // Elevation normalization (mode 3) reuses intensity_norm slot when mode=3
  if (u.mode == 3u) {
    out.intensity_norm = clamp((wy - u.min) / max(u.max - u.min, 1.0e-6), 0.0, 1.0);
  }

  out.classification = read_classification(vi);
  out.rgb = read_rgb(vi);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  if (u.mode == 1u) {
    // Classification: indexed palette lookup. Wrap to 32 entries.
    let idx = f32(in.classification % 32u) / 32.0 + (0.5 / 32.0);
    // We use the SAME ramp texture (caller binds CLASS_PALETTE padded to 256
    // or — preferred — a separate 32-entry texture. For simplicity v1 we
    // sample the ramp_tex which is bound to either color-ramp OR class-palette.
    return textureSample(ramp_tex, ramp_sampler, idx);
  }
  if (u.mode == 2u) {
    return vec4f(in.rgb, 1.0);
  }
  // mode 0 (intensity) and mode 3 (elevation) both use intensity_norm + ramp
  return textureSample(ramp_tex, ramp_sampler, in.intensity_norm);
}
`;

export async function compileColoredPointPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): Promise<ColoredPointPipeline> {
  const shaderModule = device.createShaderModule({
    code: COLORED_POINT_SHADER_WGSL,
    label: "colored-point-shader",
  });

  // WebGPU spec rename guard (same pattern as Ward 24)
  const sm = shaderModule as GPUShaderModule & {
    getCompilationInfo?: () => Promise<GPUCompilationInfo>;
    compilationInfo?: () => Promise<GPUCompilationInfo>;
  };
  const getInfo = sm.getCompilationInfo ?? sm.compilationInfo;
  if (!getInfo) {
    throw new Error("GPUShaderModule has neither getCompilationInfo nor compilationInfo");
  }
  const info = await getInfo.call(sm);
  const errors = info.messages.filter((m: { type: string }) => m.type === "error");
  if (errors.length > 0) {
    throw new Error(
      `Colored point shader compilation failed: ${errors.map((e: { message: string }) => e.message).join("; ")}`,
    );
  }

  const bindGroupLayout = device.createBindGroupLayout({
    label: "colored-point-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "1d" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "colored-point-pl",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "colored-point-pipeline",
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vs_main" },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "point-list" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  } as GPURenderPipelineDescriptor);

  return { pipeline, shaderModule, bindGroupLayout };
}
