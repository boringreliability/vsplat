/**
 * 3D Gaussian Splatting math: covariance computation, projection, and evaluation.
 *
 * CPU reference implementation. The GPU shader uses the same formulas in WGSL.
 *
 * IMPORTANT: All 4×4 matrices use Column-Major layout (WebGPU/WGSL standard).
 * Index mapping: element at row r, column c is at index [c * 4 + r].
 */

/**
 * Compute 3D covariance matrix from quaternion rotation and scale.
 * Σ = R · S · Sᵀ · Rᵀ where S = diag(scale).
 *
 * @returns 6 floats: upper triangle [σ_xx, σ_xy, σ_xz, σ_yy, σ_yz, σ_zz]
 */
export function computeCovariance3D(
  rotation: [number, number, number, number],
  scale: [number, number, number],
): number[] {
  const [w, x, y, z] = rotation;

  // Rotation matrix from quaternion
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);

  // M = R * S (scales are linear — exp() applied at parse time in Rust)
  const sx = scale[0], sy = scale[1], sz = scale[2];
  const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
  const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
  const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;

  // Σ = M * Mᵀ (upper triangle of symmetric 3×3)
  return [
    m00 * m00 + m01 * m01 + m02 * m02, // σ_xx
    m00 * m10 + m01 * m11 + m02 * m12, // σ_xy
    m00 * m20 + m01 * m21 + m02 * m22, // σ_xz
    m10 * m10 + m11 * m11 + m12 * m12, // σ_yy
    m10 * m20 + m11 * m21 + m12 * m22, // σ_yz
    m20 * m20 + m21 * m21 + m22 * m22, // σ_zz
  ];
}

/**
 * Project 3D covariance to 2D via the Jacobian of perspective projection.
 * Σ₂D = J · W · Σ₃D · Wᵀ · Jᵀ (taking only the 2×2 upper-left block).
 *
 * @param cov3d 6 floats [σ_xx, σ_xy, σ_xz, σ_yy, σ_yz, σ_zz]
 * @param viewMatrix 4×4 Column-Major view matrix (WebGPU standard).
 *   Element at row r, col c is viewMatrix[c * 4 + r].
 * @param splatPos 3D position of the splat in world space
 * @param focal [fx, fy] focal lengths in pixels
 * @returns 3 floats [a, b, c] for 2×2 symmetric matrix [[a,b],[b,c]]
 */
export function projectCovariance2D(
  cov3d: number[],
  viewMatrix: readonly number[],
  splatPos: [number, number, number],
  focal: [number, number],
): [number, number, number] | null {
  // Column-Major indexing: M[c*4+r]
  // Row 0: viewMatrix[0], viewMatrix[4], viewMatrix[8],  viewMatrix[12]
  // Row 1: viewMatrix[1], viewMatrix[5], viewMatrix[9],  viewMatrix[13]
  // Row 2: viewMatrix[2], viewMatrix[6], viewMatrix[10], viewMatrix[14]
  const [px, py, pz] = splatPos;
  const tx = viewMatrix[0] * px + viewMatrix[4] * py + viewMatrix[8] * pz + viewMatrix[12];
  const ty = viewMatrix[1] * px + viewMatrix[5] * py + viewMatrix[9] * pz + viewMatrix[13];
  const tz = viewMatrix[2] * px + viewMatrix[6] * py + viewMatrix[10] * pz + viewMatrix[14];

  // Cull splats behind camera or too close to the near plane.
  // In a right-handed view space, -Z points into the screen, so tz should be negative.
  // If tz > -0.01, the splat is behind or on the camera — return null (invalid).
  // Matches WGSL: if (view_pos.z > -0.01)
  if (tz > -0.01) {
    return null;
  }

  const z = -tz; // positive depth
  const z2 = z * z;

  // Jacobian of perspective projection
  const fx = focal[0], fy = focal[1];
  const j00 = fx / z;
  const j02 = -(fx * tx) / z2;
  const j11 = fy / z;
  const j12 = -(fy * ty) / z2;

  // W = upper-left 3×3 of view matrix (Column-Major extraction)
  const w00 = viewMatrix[0], w10 = viewMatrix[1], w20 = viewMatrix[2];
  const w01 = viewMatrix[4], w11 = viewMatrix[5], w21 = viewMatrix[6];
  const w02 = viewMatrix[8], w12 = viewMatrix[9], w22 = viewMatrix[10];

  // T = J * W (2×3 matrix)
  const t00 = j00 * w00 + j02 * w20;
  const t01 = j00 * w01 + j02 * w21;
  const t02 = j00 * w02 + j02 * w22;
  const t10 = j11 * w10 + j12 * w20;
  const t11 = j11 * w11 + j12 * w21;
  const t12 = j11 * w12 + j12 * w22;

  // Σ₂D = T * Σ₃D * Tᵀ
  const [sxx, sxy, sxz, syy, syz, szz] = cov3d;

  const ts00 = t00 * sxx + t01 * sxy + t02 * sxz;
  const ts01 = t00 * sxy + t01 * syy + t02 * syz;
  const ts02 = t00 * sxz + t01 * syz + t02 * szz;
  const ts10 = t10 * sxx + t11 * sxy + t12 * sxz;
  const ts11 = t10 * sxy + t11 * syy + t12 * syz;
  const ts12 = t10 * sxz + t11 * syz + t12 * szz;

  const a = ts00 * t00 + ts01 * t01 + ts02 * t02;
  const b = ts00 * t10 + ts01 * t11 + ts02 * t12;
  const c = ts10 * t10 + ts11 * t11 + ts12 * t12;

  return [a, b, c];
}

/**
 * Compute conic parameters (inverse 2D covariance) from 2D covariance.
 *
 * 3DGS fragment shaders use the inverse covariance (conic) for efficiency:
 * power = -0.5 * (A·dx² + 2B·dx·dy + C·dy²)
 *
 * @param cov2d [a, b, c] symmetric 2×2 matrix [[a,b],[b,c]]
 * @returns [A, B, C] conic parameters (inverse matrix upper triangle)
 */
export function computeConic2D(
  cov2d: [number, number, number],
): [number, number, number] {
  const [a, b, c] = cov2d;
  const det = a * c - b * b;

  if (Math.abs(det) < 1e-10) {
    return [1e6, 0, 1e6];
  }

  const invDet = 1.0 / det;
  return [
    c * invDet,   // A
    -b * invDet,  // B
    a * invDet,   // C
  ];
}

/**
 * Evaluate a 2D Gaussian at offset (dx, dy) using conic (inverse covariance) form.
 *
 * result = opacity * exp(-0.5 * (A·dx² + 2·B·dx·dy + C·dy²))
 *
 * @param conic [A, B, C] inverse 2D covariance parameters
 */
export function evaluateGaussian2D(
  conic: [number, number, number],
  dx: number,
  dy: number,
  opacity: number,
): number {
  const [A, B, C] = conic;
  const power = -0.5 * (A * dx * dx + 2 * B * dx * dy + C * dy * dy);
  return opacity * Math.exp(power);
}
