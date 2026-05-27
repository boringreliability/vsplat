/**
 * WebGPU Render Pipeline for Gaussian Splat billboards.
 *
 * Compiles WGSL shaders and creates the render pipeline.
 * Validates shader compilation and reports descriptive errors.
 */

export interface SplatRenderPipeline {
  /** The compiled GPURenderPipeline */
  pipeline: GPURenderPipeline;
  /** The compiled shader module */
  shaderModule: GPUShaderModule;
}

/** WGSL shader for instanced billboard quads colored by splat position. */
const SPLAT_SHADER_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@group(0) @binding(0)
var<storage, read> splat_positions: array<f32>;

// Hardcoded camera (Ward 8 will replace with dynamic camera)
const VIEW_PROJ = mat4x4f(
  vec4f(1.0, 0.0, 0.0, 0.0),
  vec4f(0.0, 1.0, 0.0, 0.0),
  vec4f(0.0, 0.0, 1.0, 0.0),
  vec4f(0.0, 0.0, -5.0, 1.0),
);

// Billboard quad offsets (triangle strip: 4 vertices per instance)
const QUAD_OFFSETS = array<vec2f, 4>(
  vec2f(-0.005, -0.005),
  vec2f( 0.005, -0.005),
  vec2f(-0.005,  0.005),
  vec2f( 0.005,  0.005),
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
  let base = instance_index * 3u;
  let pos = vec3f(
    splat_positions[base],
    splat_positions[base + 1u],
    splat_positions[base + 2u],
  );

  let offset = QUAD_OFFSETS[vertex_index];
  let world_pos = vec4f(pos.x + offset.x, pos.y + offset.y, pos.z, 1.0);
  let clip_pos = VIEW_PROJ * world_pos;

  // Color from position for debug visualisation (Ward 7 will use SH)
  let color = normalize(abs(pos)) * 0.8 + 0.2;

  var out: VertexOutput;
  out.position = clip_pos;
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(in.color, 0.8);
}
`;

/**
 * Compile the splat render pipeline.
 *
 * @throws If shader compilation produces errors
 */
export async function compileRenderPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): Promise<SplatRenderPipeline> {
  const shaderModule = device.createShaderModule({
    code: SPLAT_SHADER_WGSL,
    label: "splat-shader",
  });

  // WebGPU spec renamed compilationInfo() → getCompilationInfo() (Chrome 119+).
  // Prefer new API, fall back to legacy, throw descriptively if neither.
  const sm = shaderModule as GPUShaderModule & {
    getCompilationInfo?: () => Promise<GPUCompilationInfo>;
    compilationInfo?: () => Promise<GPUCompilationInfo>;
  };
  const getInfo = sm.getCompilationInfo ?? sm.compilationInfo;
  if (!getInfo) {
    throw new Error(
      "GPUShaderModule has neither getCompilationInfo nor compilationInfo",
    );
  }
  const compilationInfo = await getInfo.call(sm);
  const errors = compilationInfo.messages.filter(
    (m: { type: string }) => m.type === "error",
  );
  if (errors.length > 0) {
    const details = errors
      .map((e: { message: string }) => e.message)
      .join("; ");
    throw new Error(`Shader compilation failed: ${details}`);
  }

  const pipeline = device.createRenderPipeline({
    label: "splat-render-pipeline",
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
            },
          },
        },
      ],
    },
    primitive: {
      topology: "triangle-strip",
    },
  } as GPURenderPipelineDescriptor);

  return { pipeline, shaderModule };
}
