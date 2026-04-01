/**
 * Spherical Harmonics evaluation for 3D Gaussian Splatting.
 *
 * CPU reference implementation. Supports degrees 0-3 (1, 4, 9, 16 basis functions).
 * Uses the standard 3DGS color mapping: color = SH_C0 * dc + 0.5 + higher_order_terms.
 */

// SH constants (standard normalisation factors)
export const SH_C0 = 0.28209479177387814;
export const SH_C1 = 0.4886025119029199;
export const SH_C2 = [
  1.0925484305920792,
  -1.0925484305920792,
  0.31539156525252005,
  -1.0925484305920792,
  0.5462742152960396,
];
export const SH_C3 = [
  -0.5900435899266435,
  2.890611442640554,
  -0.4570457994644658,
  0.3731763325901154,
  -0.4570457994644658,
  1.445305721320277,
  -0.5900435899266435,
];

/**
 * Evaluate Spherical Harmonics for a given direction and degree.
 *
 * @param coeffs SH coefficients, stored as [R,G,B] per basis function.
 *   Degree 0: 3 floats, Degree 1: 12, Degree 2: 27, Degree 3: 48.
 * @param dir Normalised view direction (unit vector from splat toward camera)
 * @param degree Maximum SH degree to evaluate (0-3)
 * @returns [R, G, B] color after 3DGS sigmoid mapping (+ 0.5)
 */
export function evaluateSH(
  coeffs: number[],
  dir: [number, number, number],
  degree: number,
): [number, number, number] {
  const [x, y, z] = dir;
  const result: [number, number, number] = [0, 0, 0];

  // Degree 0: DC term (constant, view-independent)
  // Y_0^0 = SH_C0
  for (let c = 0; c < 3; c++) {
    result[c] += SH_C0 * coeffs[c];
  }

  if (degree >= 1 && coeffs.length >= 12) {
    // Degree 1: Y_1^{-1} = C1*y, Y_1^0 = C1*z, Y_1^1 = C1*x
    const base = 3;
    for (let c = 0; c < 3; c++) {
      result[c] += SH_C1 * y * coeffs[base + c];       // Y_1^{-1}
      result[c] += SH_C1 * z * coeffs[base + 3 + c];   // Y_1^{0}
      result[c] += SH_C1 * x * coeffs[base + 6 + c];   // Y_1^{+1}
    }
  }

  if (degree >= 2 && coeffs.length >= 27) {
    // Degree 2: 5 basis functions
    const base = 12;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, yz = y * z, xz = x * z;
    for (let c = 0; c < 3; c++) {
      result[c] += SH_C2[0] * xy * coeffs[base + c];              // Y_2^{-2}
      result[c] += SH_C2[1] * yz * coeffs[base + 3 + c];          // Y_2^{-1}
      result[c] += SH_C2[2] * (2 * zz - xx - yy) * coeffs[base + 6 + c]; // Y_2^{0}
      result[c] += SH_C2[3] * xz * coeffs[base + 9 + c];          // Y_2^{+1}
      result[c] += SH_C2[4] * (xx - yy) * coeffs[base + 12 + c];  // Y_2^{+2}
    }
  }

  if (degree >= 3 && coeffs.length >= 48) {
    // Degree 3: 7 basis functions
    const base = 27;
    const xx = x * x, yy = y * y, zz = z * z;
    for (let c = 0; c < 3; c++) {
      result[c] += SH_C3[0] * y * (3 * xx - yy) * coeffs[base + c];
      result[c] += SH_C3[1] * x * y * z * coeffs[base + 3 + c];
      result[c] += SH_C3[2] * y * (4 * zz - xx - yy) * coeffs[base + 6 + c];
      result[c] += SH_C3[3] * z * (2 * zz - 3 * xx - 3 * yy) * coeffs[base + 9 + c];
      result[c] += SH_C3[4] * x * (4 * zz - xx - yy) * coeffs[base + 12 + c];
      result[c] += SH_C3[5] * z * (xx - yy) * coeffs[base + 15 + c];
      result[c] += SH_C3[6] * x * (xx - 3 * yy) * coeffs[base + 18 + c];
    }
  }

  // 3DGS sigmoid mapping: add 0.5 baseline
  result[0] += 0.5;
  result[1] += 0.5;
  result[2] += 0.5;

  // Clamp to 0 — negative colors are physically meaningless.
  // Matches WGSL: max(color, vec3f(0.0))
  result[0] = Math.max(result[0], 0.0);
  result[1] = Math.max(result[1], 0.0);
  result[2] = Math.max(result[2], 0.0);

  return result;
}
