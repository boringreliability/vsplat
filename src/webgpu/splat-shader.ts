/**
 * 3DGS Vertex + Fragment shader compilation.
 *
 * WGSL shader that:
 * - Computes 3D covariance from quaternion rotation + scale
 * - Projects to 2D via Jacobian and inverts to conic parameters
 * - Sizes billboard quads dynamically from 3-sigma eigenvalue extent
 * - Evaluates Spherical Harmonics degrees 0-3 for view-dependent color
 * - Applies Gaussian falloff and premultiplied alpha blending
 *
 * All matrices use Column-Major layout (WebGPU/WGSL standard).
 * Fragment shader Y-axis is flipped: (0,0) at top-left in pixel space.
 */

export interface SplatShaderPipeline {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
}

const SPLAT_3DGS_WGSL = /* wgsl */ `
// ─── 3D Gaussian Splatting — Full Vertex + Fragment Shader ───────
// Computes covariance, projects to conic, evaluates SH degree 0-3.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) conic_and_opacity: vec4f,
  @location(1) center: vec2f,
  @location(2) color: vec3f,
};

struct CameraUniforms {
  view: mat4x4f,
  proj: mat4x4f,
  camera_pos: vec3f,
  focal: vec2f,
  viewport: vec2f,
  sh_degree: u32,
  sh_dim: u32,
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read> rotations: array<f32>;
@group(0) @binding(2) var<storage, read> scales: array<f32>;
@group(0) @binding(3) var<storage, read> opacities: array<f32>;
@group(0) @binding(4) var<storage, read> sh_coefficients: array<f32>;
@group(0) @binding(5) var<storage, read> sorted_indices: array<u32>;

@group(1) @binding(0) var<uniform> camera: CameraUniforms;

// ─── SH Constants ────────────────────────────────────────────────
const SH_C0: f32 = 0.28209479177387814;
const SH_C1: f32 = 0.4886025119029199;
const SH_C2_0: f32 =  1.0925484305920792;
const SH_C2_1: f32 = -1.0925484305920792;
const SH_C2_2: f32 =  0.31539156525252005;
const SH_C2_3: f32 = -1.0925484305920792;
const SH_C2_4: f32 =  0.5462742152960396;
const SH_C3_0: f32 = -0.5900435899266435;
const SH_C3_1: f32 =  2.890611442640554;
const SH_C3_2: f32 = -0.4570457994644658;
const SH_C3_3: f32 =  0.3731763325901154;
const SH_C3_4: f32 = -0.4570457994644658;
const SH_C3_5: f32 =  1.445305721320277;
const SH_C3_6: f32 = -0.5900435899266435;

// ─── SH Evaluation (Degree 0-3) ─────────────────────────────────
fn evaluate_sh(idx: u32, dir: vec3f) -> vec3f {
  let base = idx * camera.sh_dim;
  let x = dir.x; let y = dir.y; let z = dir.z;

  // Degree 0: DC (constant, view-independent)
  var color = vec3f(
    SH_C0 * sh_coefficients[base]     + 0.5,
    SH_C0 * sh_coefficients[base + 1u] + 0.5,
    SH_C0 * sh_coefficients[base + 2u] + 0.5,
  );

  if (camera.sh_degree >= 1u && camera.sh_dim >= 12u) {
    // Degree 1: Y_1^{-1}=y, Y_1^0=z, Y_1^{+1}=x
    let b1 = base + 3u;
    color += SH_C1 * y * vec3f(sh_coefficients[b1], sh_coefficients[b1+1u], sh_coefficients[b1+2u]);
    color += SH_C1 * z * vec3f(sh_coefficients[b1+3u], sh_coefficients[b1+4u], sh_coefficients[b1+5u]);
    color += SH_C1 * x * vec3f(sh_coefficients[b1+6u], sh_coefficients[b1+7u], sh_coefficients[b1+8u]);
  }

  if (camera.sh_degree >= 2u && camera.sh_dim >= 27u) {
    let b2 = base + 12u;
    let xx = x*x; let yy = y*y; let zz = z*z;
    let xy = x*y; let yz = y*z; let xz = x*z;
    color += SH_C2_0 * xy   * vec3f(sh_coefficients[b2],    sh_coefficients[b2+1u],  sh_coefficients[b2+2u]);
    color += SH_C2_1 * yz   * vec3f(sh_coefficients[b2+3u], sh_coefficients[b2+4u],  sh_coefficients[b2+5u]);
    color += SH_C2_2 * (2.0*zz - xx - yy) * vec3f(sh_coefficients[b2+6u], sh_coefficients[b2+7u], sh_coefficients[b2+8u]);
    color += SH_C2_3 * xz   * vec3f(sh_coefficients[b2+9u], sh_coefficients[b2+10u], sh_coefficients[b2+11u]);
    color += SH_C2_4 * (xx - yy) * vec3f(sh_coefficients[b2+12u], sh_coefficients[b2+13u], sh_coefficients[b2+14u]);
  }

  if (camera.sh_degree >= 3u && camera.sh_dim >= 48u) {
    let b3 = base + 27u;
    let xx = x*x; let yy = y*y; let zz = z*z;
    color += SH_C3_0 * y*(3.0*xx - yy) * vec3f(sh_coefficients[b3], sh_coefficients[b3+1u], sh_coefficients[b3+2u]);
    color += SH_C3_1 * x*y*z * vec3f(sh_coefficients[b3+3u], sh_coefficients[b3+4u], sh_coefficients[b3+5u]);
    color += SH_C3_2 * y*(4.0*zz - xx - yy) * vec3f(sh_coefficients[b3+6u], sh_coefficients[b3+7u], sh_coefficients[b3+8u]);
    color += SH_C3_3 * z*(2.0*zz - 3.0*xx - 3.0*yy) * vec3f(sh_coefficients[b3+9u], sh_coefficients[b3+10u], sh_coefficients[b3+11u]);
    color += SH_C3_4 * x*(4.0*zz - xx - yy) * vec3f(sh_coefficients[b3+12u], sh_coefficients[b3+13u], sh_coefficients[b3+14u]);
    color += SH_C3_5 * z*(xx - yy) * vec3f(sh_coefficients[b3+15u], sh_coefficients[b3+16u], sh_coefficients[b3+17u]);
    color += SH_C3_6 * x*(xx - 3.0*yy) * vec3f(sh_coefficients[b3+18u], sh_coefficients[b3+19u], sh_coefficients[b3+20u]);
  }

  return max(color, vec3f(0.0));
}

// ─── 3D Covariance from Quaternion + Scale ───────────────────────
// Returns upper triangle [σ_xx, σ_xy, σ_xz, σ_yy, σ_yz, σ_zz] as two vec3f.
fn compute_cov3d(quat: vec4f, scale: vec3f) -> array<f32, 6> {
  let w = quat.x; let x = quat.y; let y = quat.z; let z = quat.w;

  // Rotation matrix from quaternion
  let r00 = 1.0 - 2.0*(y*y + z*z); let r01 = 2.0*(x*y - w*z); let r02 = 2.0*(x*z + w*y);
  let r10 = 2.0*(x*y + w*z); let r11 = 1.0 - 2.0*(x*x + z*z); let r12 = 2.0*(y*z - w*x);
  let r20 = 2.0*(x*z - w*y); let r21 = 2.0*(y*z + w*x); let r22 = 1.0 - 2.0*(x*x + y*y);

  // M = R * S
  let sx = scale.x; let sy = scale.y; let sz = scale.z;
  let m00 = r00*sx; let m01 = r01*sy; let m02 = r02*sz;
  let m10 = r10*sx; let m11 = r11*sy; let m12 = r12*sz;
  let m20 = r20*sx; let m21 = r21*sy; let m22 = r22*sz;

  // Σ = M * Mᵀ
  return array<f32, 6>(
    m00*m00 + m01*m01 + m02*m02,
    m00*m10 + m01*m11 + m02*m12,
    m00*m20 + m01*m21 + m02*m22,
    m10*m10 + m11*m11 + m12*m12,
    m10*m20 + m11*m21 + m12*m22,
    m20*m20 + m21*m21 + m22*m22,
  );
}

// ─── Project 3D Covariance → 2D Conic ───────────────────────────
// Returns conic (A, B, C) = inverse of 2D covariance, plus the 2D covariance
// eigenvalue-based radius for quad sizing.
struct ConicResult {
  conic: vec3f,   // (A, B, C) inverse 2D covariance
  radius: f32,    // 3-sigma pixel radius for quad extent
};

fn project_to_conic(cov3d: array<f32, 6>, world_pos: vec3f) -> ConicResult {
  // Transform position to view space (Column-Major mat4x4)
  // Note: view_pos.z is negative for splats in front of camera (right-handed, -Z into screen).
  // Caller (vs_main) has already culled splats with view_pos.z > -0.01.
  let view_pos = camera.view * vec4f(world_pos, 1.0);
  let tz = -view_pos.z; // positive depth (negated from view space)
  let tz2 = tz * tz;

  // Jacobian of perspective projection
  let j00 = camera.focal.x / tz;
  let j02 = -(camera.focal.x * view_pos.x) / tz2;
  let j11 = camera.focal.y / tz;
  let j12 = -(camera.focal.y * view_pos.y) / tz2;

  // W = upper-left 3×3 of view matrix (WGSL mat4x4 is Column-Major: camera.view[col][row])
  let w00 = camera.view[0][0]; let w01 = camera.view[1][0]; let w02 = camera.view[2][0];
  let w10 = camera.view[0][1]; let w11 = camera.view[1][1]; let w12 = camera.view[2][1];
  let w20 = camera.view[0][2]; let w21 = camera.view[1][2]; let w22 = camera.view[2][2];

  // T = J * W (2×3)
  let t00 = j00*w00 + j02*w20; let t01 = j00*w01 + j02*w21; let t02 = j00*w02 + j02*w22;
  let t10 = j11*w10 + j12*w20; let t11 = j11*w11 + j12*w21; let t12 = j11*w12 + j12*w22;

  // Σ₂D = T * Σ₃D * Tᵀ
  let sxx = cov3d[0]; let sxy = cov3d[1]; let sxz = cov3d[2];
  let syy = cov3d[3]; let syz = cov3d[4]; let szz = cov3d[5];

  let ts00 = t00*sxx + t01*sxy + t02*sxz;
  let ts01 = t00*sxy + t01*syy + t02*syz;
  let ts02 = t00*sxz + t01*syz + t02*szz;
  let ts10 = t10*sxx + t11*sxy + t12*sxz;
  let ts11 = t10*sxy + t11*syy + t12*syz;
  let ts12 = t10*sxz + t11*syz + t12*szz;

  let cov_a = ts00*t00 + ts01*t01 + ts02*t02;
  let cov_b = ts00*t10 + ts01*t11 + ts02*t12;
  let cov_c = ts10*t10 + ts11*t11 + ts12*t12;

  // Invert to conic (A, B, C)
  let det = cov_a * cov_c - cov_b * cov_b;
  let inv_det = 1.0 / max(det, 1e-10);
  let conic = vec3f(cov_c * inv_det, -cov_b * inv_det, cov_a * inv_det);

  // 3-sigma radius from eigenvalues of 2D covariance
  let mid = 0.5 * (cov_a + cov_c);
  let disc = max(mid * mid - det, 0.0);
  let lambda_max = mid + sqrt(disc);
  let radius = ceil(3.0 * sqrt(lambda_max));

  return ConicResult(conic, radius);
}

// ─── Quad Offsets ────────────────────────────────────────────────
const QUAD_OFFSETS = array<vec2f, 4>(
  vec2f(-1.0, -1.0),
  vec2f( 1.0, -1.0),
  vec2f(-1.0,  1.0),
  vec2f( 1.0,  1.0),
);

// ─── Vertex Shader ───────────────────────────────────────────────
// OPTIMIZATION NOTE: Currently cov3d and conic are computed per-vertex (4x per splat).
// In a production setup, this should be moved to a pre-compute pass or evaluated
// per-instance if the topology allows.
@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> VertexOutput {
  let idx = sorted_indices[iid];
  let b3 = idx * 3u;
  let b4 = idx * 4u;

  let world_pos = vec3f(positions[b3], positions[b3+1u], positions[b3+2u]);

  // ─── Back-camera culling ───────────────────────────────────────
  // Right-handed view space: -Z points into the screen.
  // Cull splats that are behind or too close to the camera.
  let view_pos = camera.view * vec4f(world_pos, 1.0);
  if (view_pos.z > -0.01) {
    var out: VertexOutput;
    out.position = vec4f(2.0, 2.0, 2.0, 1.0); // Outside clip space → culled
    return out;
  }

  let quat = vec4f(rotations[b4], rotations[b4+1u], rotations[b4+2u], rotations[b4+3u]);
  let scale = vec3f(scales[b3], scales[b3+1u], scales[b3+2u]);
  let opacity = opacities[idx];

  // Compute 3D covariance → project to 2D → invert to conic
  let cov3d = compute_cov3d(quat, scale);
  let cr = project_to_conic(cov3d, world_pos);

  // Project position to clip space
  let clip = camera.proj * camera.view * vec4f(world_pos, 1.0);
  let ndc = clip.xy / clip.w;

  // Screen-space center (Y-flipped: WebGPU pixel space has (0,0) at top-left)
  let screen_center = vec2f(
    (ndc.x * 0.5 + 0.5) * camera.viewport.x,
    (0.5 - ndc.y * 0.5) * camera.viewport.y,
  );

  // Billboard quad offset scaled by 3-sigma radius (dynamic, not hardcoded)
  let pixel_offset = QUAD_OFFSETS[vid] * cr.radius;
  let ndc_offset = pixel_offset / camera.viewport * 2.0;

  var out: VertexOutput;
  out.position = vec4f(ndc + ndc_offset, clip.z / clip.w, 1.0);
  out.conic_and_opacity = vec4f(cr.conic, opacity);
  out.center = screen_center;

  // SH evaluation with view direction (splat → camera, i.e. pointing toward camera)
  let view_dir = normalize(camera.camera_pos - world_pos);
  out.color = evaluate_sh(idx, view_dir);

  return out;
}

// ─── Fragment Shader ─────────────────────────────────────────────
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // dx, dy in pixel space from fragment to splat center
  let dx = in.position.xy - in.center;
  let conic = in.conic_and_opacity.xyz;
  let opacity = in.conic_and_opacity.w;

  // Gaussian evaluation: exp(-0.5 * (A·dx² + 2B·dx·dy + C·dy²))
  let power = -0.5 * (conic.x * dx.x * dx.x + 2.0 * conic.y * dx.x * dx.y + conic.z * dx.y * dx.y);

  // Clamp power to avoid exp() overflow
  if (power > 0.0) {
    discard;
  }

  let alpha = min(opacity * exp(power), 0.999);

  if (alpha < 1.0 / 255.0) {
    discard;
  }

  // Premultiplied alpha output
  return vec4f(in.color * alpha, alpha);
}
`;

/**
 * Compile the 3DGS splat render shader.
 *
 * @throws If shader compilation produces errors
 */
export async function compileSplatShader(
  device: GPUDevice,
  format: GPUTextureFormat,
): Promise<SplatShaderPipeline> {
  const shaderModule = device.createShaderModule({
    code: SPLAT_3DGS_WGSL,
    label: "splat-3dgs-shader",
  });

  const compilationInfo = await shaderModule.compilationInfo();
  const errors = compilationInfo.messages.filter(
    (m: { type: string }) => m.type === "error",
  );
  if (errors.length > 0) {
    const details = errors.map((e: { message: string }) => e.message).join("; ");
    throw new Error(`Splat shader compilation failed: ${details}`);
  }

  const pipeline = device.createRenderPipeline({
    label: "splat-3dgs-pipeline",
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-strip" },
  } as GPURenderPipelineDescriptor);

  return { pipeline, shaderModule };
}
