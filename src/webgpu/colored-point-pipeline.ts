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

/**
 * View-projection som shaderen bruger — column-major, samme konvention som
 * resten af projektet (`mat[col * 4 + row]`).
 *
 * Positionerne er allerede normaliseret til [-1, 1] på CPU-siden, så det her er
 * reelt identitet med en z-remap til WebGPU's [0, 1] dybdeområde. Den er
 * eksporteret fordi Ward 23's CPU-side frustum cull SKAL bruge præcis samme
 * matrix som shaderen — to kopier ville drive fra hinanden.
 */
export const VIEW_PROJ_MATRIX = new Float32Array([
  1.0, 0.0, 0.0, 0.0,
  0.0, 1.0, 0.0, 0.0,
  0.0, 0.0, 0.5, 0.0,
  0.0, 0.0, 0.5, 1.0,
]);

/** Formatér en column-major mat4 som WGSL `mat4x4f`-kolonner. */
function wgslMat4(m: Float32Array): string {
  const col = (c: number) =>
    `  vec4f(${[0, 1, 2, 3].map(r => m[c * 4 + r]!.toFixed(1)).join(", ")})`;
  return [0, 1, 2, 3].map(col).join(",\n");
}

// Ward 23: triangle-list topology with 6-vertex quads per point.
// WGSL no longer exposes @builtin(point_size), so variable point sizes require
// quad-based billboards. Each point becomes a 2-triangle quad at clip-space center,
// sized perspective-correct by `base_size_px / clip_w * density_factor`.
const COLORED_POINT_SHADER_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) intensity_norm: f32,
  @location(1) @interpolate(flat) classification: u32,
  @location(2) rgb: vec3f,
};

struct ColorUniform {
  min: f32,
  max: f32,
  mode: u32,
  _pad: u32,
};

struct SizeUniform {
  base_size_px: f32,
  max_size_px: f32,
  density_factor: f32,
  viewport_px: f32,
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read> intensities: array<u32>;
@group(0) @binding(2) var<storage, read> rgb_buffer: array<u32>;
@group(0) @binding(3) var<storage, read> classifications: array<u32>;
@group(0) @binding(4) var ramp_tex: texture_1d<f32>;
@group(0) @binding(5) var ramp_sampler: sampler;
@group(0) @binding(6) var<uniform> u: ColorUniform;
@group(0) @binding(7) var<uniform> s: SizeUniform;

const VIEW_PROJ = mat4x4f(
${wgslMat4(VIEW_PROJ_MATRIX)}
);

// Quad corner offsets for 2-triangle quad (6 vertices, triangle-list)
// Order: tri1=(BL,BR,TL), tri2=(TL,BR,TR)
const QUAD_CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
  vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
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

// Pseudo-random per-point hash for adaptive density dropping.
fn point_hash(idx: u32) -> f32 {
  return fract(sin(f32(idx) * 12.9898) * 43758.5453);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let point_idx = vi / 6u;
  let corner_idx = vi % 6u;
  let corner = QUAD_CORNERS[corner_idx];

  let base = point_idx * 3u;
  let wx = positions[base + 0u];
  let wy = positions[base + 1u];
  let wz = positions[base + 2u];

  var out: VertexOutput;

  // Density-based culling: drop point if hash > density_factor.
  // Culled point emits NaN position -> GPU discards quad.
  if (point_hash(point_idx) > s.density_factor) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);  // outside clip space [-1,1] → GPU clips
    return out;
  }

  let clip_center = VIEW_PROJ * vec4f(wx, wy, wz, 1.0);

  // Perspective-correct size in pixels, clamped [1.0, max_size_px]
  let size_px = clamp(s.base_size_px / max(clip_center.w, 1.0e-6),
                       1.0, s.max_size_px);
  // Convert to NDC offset: pixels / viewport_px * 2 (NDC range is [-1,1])
  let size_ndc = size_px / s.viewport_px * 2.0;

  // Clip-space frustum cull: skip if quad center is outside expanded frustum.
  let ndc_xy = clip_center.xy / max(clip_center.w, 1.0e-6);
  if (any(abs(ndc_xy) > vec2f(1.0 + size_ndc))) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);  // outside clip space [-1,1] → GPU clips
    return out;
  }

  out.position = vec4f(
    clip_center.xy + corner * size_ndc * clip_center.w,
    clip_center.z, clip_center.w,
  );

  let raw_intensity = f32(read_intensity(point_idx));
  out.intensity_norm = clamp((raw_intensity - u.min) / max(u.max - u.min, 1.0e-6), 0.0, 1.0);
  if (u.mode == 3u) {
    // Elevation: use original world-y (pre-rotation) so colors stay anchored to scene up-axis
    out.intensity_norm = clamp((wy - u.min) / max(u.max - u.min, 1.0e-6), 0.0, 1.0);
  }

  out.classification = read_classification(point_idx);
  out.rgb = read_rgb(point_idx);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  if (u.mode == 1u) {
    let idx = f32(in.classification % 32u) / 32.0 + (0.5 / 32.0);
    return textureSample(ramp_tex, ramp_sampler, idx);
  }
  if (u.mode == 2u) {
    return vec4f(in.rgb, 1.0);
  }
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
      // Ward 23: size uniform (base_size_px, max_size_px, density_factor, viewport_px)
      { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
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
    // Ward 23: triangle-list med quad-billboards (6 vertices/point)
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  } as GPURenderPipelineDescriptor);

  return { pipeline, shaderModule, bindGroupLayout };
}
