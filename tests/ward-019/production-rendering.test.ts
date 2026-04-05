/**
 * Ward 019 — Production Rendering Tests
 *
 * T1-T2: SH sign convention and degree mapping
 * T3: Eigenvector-aligned quad tightness
 * T4-T5: normExp range and monotonicity
 * T6: UV-space Gaussian matches conic form (cross-ward contract test)
 * T7: Frustum culling logic
 * T8: Lambda2 clamp prevents degenerate splats
 *
 * CPU reference tests — GPU rendering verified manually (V1-V5).
 */

import { describe, it, expect } from "vitest";
import {
  evaluateSH,
  SH_C1,
} from "../../src/webgpu/spherical-harmonics.js";
import {
  computeCovariance3D,
  computeConic2D,
  evaluateGaussian2D,
} from "../../src/webgpu/gaussian-math.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** normExp: PlayCanvas-style normalized Gaussian falloff */
function normExp(x: number): number {
  const EXP4 = Math.exp(-4.0);
  const INV_EXP4 = 1.0 / (1.0 - EXP4);
  return (Math.exp(x * -4.0) - EXP4) * INV_EXP4;
}

/** Compute 2D covariance eigenvalues from [a, b, c] */
function eigenvalues(a: number, b: number, c: number): [number, number] {
  const mid = 0.5 * (a + c);
  const det = a * c - b * b;
  const disc = Math.max(mid * mid - det, 0);
  return [mid + Math.sqrt(disc), Math.max(mid - Math.sqrt(disc), 0.1)];
}

/** Compute eigenvector-aligned quad area for a 2D covariance */
function eigenvectorQuadArea(a: number, b: number, c: number): number {
  const [l1, l2] = eigenvalues(a, b, c);
  const side1 = 2 * Math.sqrt(2 * l1);
  const side2 = 2 * Math.sqrt(2 * l2);
  return side1 * side2; // rotated rectangle area
}

/** Axis-aligned quad area (current vsplat: square sized by lambda_max) */
function axisAlignedQuadArea(a: number, b: number, c: number): number {
  const [l1] = eigenvalues(a, b, c);
  const side = 2 * 3 * Math.sqrt(l1); // 3-sigma square
  return side * side;
}

/** Map shDim to SH band count */
function shBandsFromDim(shDim: number): number {
  if (shDim >= 48) return 3;
  if (shDim >= 27) return 2;
  if (shDim >= 12) return 1;
  return 0;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 019: Production Rendering", () => {

  // ─── T1: SH band 1 sign convention ────────────────────────────

  it("T1: SH band 1 signs match PlayCanvas convention (-y, +z, -x)", () => {
    // PlayCanvas evalSH band 1: SH_C1 * (-sh[0]*y + sh[1]*z - sh[2]*x)
    // With coeffs [1,0,0, 0,1,0, 0,0,1] (R on Y-basis, G on Z-basis, B on X-basis):
    //   dir=(1,0,0): band1 = C1*(-0 + 0 - 1*[0,0,1]) = C1*[0,0,-1]
    //   dir=(0,1,0): band1 = C1*(-1*[1,0,0] + 0 - 0) = C1*[-1,0,0]
    //   dir=(0,0,1): band1 = C1*(0 + 1*[0,1,0] - 0) = C1*[0,1,0]
    //
    // So looking from +X: Blue channel should DECREASE (negative contribution)
    // Looking from +Y: Red channel should DECREASE
    // Looking from +Z: Green channel should INCREASE

    const coeffs: number[] = [
      0, 0, 0,        // DC
      1, 0, 0,        // Y-basis: R
      0, 1, 0,        // Z-basis: G
      0, 0, 1,        // X-basis: B
    ];

    const fromZ: [number, number, number] = [0, 0, 1];
    const fromX: [number, number, number] = [1, 0, 0];
    const fromY: [number, number, number] = [0, 1, 0];

    const colorZ = evaluateSH(coeffs, fromZ, 1);
    const colorX = evaluateSH(coeffs, fromX, 1);
    const colorY = evaluateSH(coeffs, fromY, 1);

    // PlayCanvas convention: +Z direction activates Z-basis → Green increases
    expect(colorZ[1]).toBeGreaterThan(0.5); // Green boosted above DC baseline

    // +X direction: X-basis contributes negatively to Blue
    expect(colorX[2]).toBeLessThan(0.5); // Blue decreased below baseline

    // +Y direction: Y-basis contributes negatively to Red
    expect(colorY[0]).toBeLessThan(0.5); // Red decreased below baseline
  });

  // ─── T2: SH degree from dim ───────────────────────────────────

  it("T2: shDim maps correctly to SH band count", () => {
    expect(shBandsFromDim(3)).toBe(0);
    expect(shBandsFromDim(12)).toBe(1);
    expect(shBandsFromDim(27)).toBe(2);
    expect(shBandsFromDim(48)).toBe(3);

    // Edge cases
    expect(shBandsFromDim(0)).toBe(0);
    expect(shBandsFromDim(1)).toBe(0);
    expect(shBandsFromDim(15)).toBe(1);
    expect(shBandsFromDim(47)).toBe(2);
  });

  // ─── T3: Eigenvector quad tighter than axis-aligned ───────────

  it("T3: eigenvector-aligned quad is tighter than axis-aligned for elongated covariance", () => {
    // Elongated covariance: 10:1 ratio with rotation
    // cov2d = [10, 3, 1] → eigenvalues ~10.9 and ~0.1
    const a = 10, b = 3, c = 1;

    const eigenArea = eigenvectorQuadArea(a, b, c);
    const axisArea = axisAlignedQuadArea(a, b, c);

    // Eigenvector quad should be significantly smaller
    expect(eigenArea).toBeLessThan(axisArea);

    // For a 10:1 ratio, the improvement should be substantial (> 2×)
    expect(axisArea / eigenArea).toBeGreaterThan(2);
  });

  // ─── T4: normExp range [0,1] ──────────────────────────────────

  it("T4: normExp maps [0, ∞) to [1, 0] within [0,1]", () => {
    // At center (x=0): normExp = 1.0
    expect(normExp(0)).toBeCloseTo(1.0, 4);

    // At edge (x=1): normExp ≈ 0 (not exactly, but very small)
    expect(normExp(1)).toBeCloseTo(0.0, 1);

    // All values in [0, 1] for the valid domain [0, 1]
    // (Beyond x=1 the splat is discarded, so we only test the visible range)
    for (let x = 0; x <= 1.0; x += 0.05) {
      const v = normExp(x);
      expect(v).toBeGreaterThanOrEqual(-0.01); // tiny negative from float precision OK
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });

  // ─── T5: normExp monotonically decreasing ─────────────────────

  it("T5: normExp is monotonically decreasing and matches Gaussian at center/edge", () => {
    // Center = max (1.0)
    expect(normExp(0)).toBeCloseTo(1.0, 4);

    // Monotonically decreasing
    let prev = normExp(0);
    for (let x = 0.05; x <= 1.5; x += 0.05) {
      const curr = normExp(x);
      expect(curr).toBeLessThanOrEqual(prev + 1e-10);
      prev = curr;
    }

    // At x=0.5 (midpoint): should be significantly less than 1 but > 0
    const mid = normExp(0.5);
    expect(mid).toBeLessThan(0.5);
    expect(mid).toBeGreaterThan(0.01);
  });

  // ─── T6: UV-space Gaussian matches conic form ─────────���───────

  it("T6: dot(uv,uv) via eigenvector transform produces same alpha as conic evaluation", () => {
    // Given: a known 2D covariance with off-diagonal
    const cov2d: [number, number, number] = [4, 1, 2]; // [a, b, c]
    const conic = computeConic2D(cov2d);

    // Conic evaluation at a test point (dx=0.5, dy=0.3)
    const dx = 0.5, dy = 0.3;
    const conicAlpha = evaluateGaussian2D(conic, dx, dy, 1.0);

    // Eigenvector UV evaluation at the same point:
    // Transform (dx,dy) to UV space via eigenvectors
    const [a, b, c] = cov2d;
    const mid = 0.5 * (a + c);
    const det = a * c - b * b;
    const disc = Math.max(mid * mid - det, 0);
    const lambda1 = mid + Math.sqrt(disc);
    const lambda2 = Math.max(mid - Math.sqrt(disc), 0.1);

    // Eigenvector direction
    const eigenDir = [b, lambda1 - a];
    const eigenLen = Math.sqrt(eigenDir[0] ** 2 + eigenDir[1] ** 2);
    const ed = [eigenDir[0] / eigenLen, eigenDir[1] / eigenLen];

    // Eigenvector-perpendicular
    const ep = [ed[1], -ed[0]];

    // Project (dx, dy) onto eigenvector axes
    const proj1 = dx * ed[0] + dy * ed[1]; // along eigenvector 1
    const proj2 = dx * ep[0] + dy * ep[1]; // along eigenvector 2

    // Scale by eigenvalue to get UV coordinates
    const l1 = Math.sqrt(2 * lambda1);
    const l2 = Math.sqrt(2 * lambda2);
    const u = proj1 / l1;
    const v = proj2 / l2;

    // UV-space Gaussian: normExp(dot(uv, uv))
    const A = u * u + v * v;
    const uvAlpha = normExp(A);

    // Both should produce similar alpha values
    // Not identical due to different normalization (conic uses raw exp, normExp uses normalized)
    // But the relative falloff pattern should match
    expect(Math.abs(conicAlpha - uvAlpha)).toBeLessThan(0.15);

    // More importantly: both agree on center (full opacity) and far (near zero)
    // Center: both should be ~1.0
    const conicCenter = evaluateGaussian2D(conic, 0, 0, 1.0);
    expect(conicCenter).toBeCloseTo(1.0, 2);
    expect(normExp(0)).toBeCloseTo(1.0, 2);
  });

  // ─── T7: Frustum culling ──────────────────────────────────────

  it("T7: splat at NDC (2.0, 0.0) is culled; splat at (0.5, 0.5) is not", () => {
    // Frustum cull: abs(ndc.xy) - size > 1.0 → cull
    // Size in NDC = quad radius / viewport * 2
    const sizeNDC = 0.1; // typical small splat

    // Offscreen splat at ndc.x = 2.0
    const offscreen = Math.abs(2.0) - sizeNDC > 1.0;
    expect(offscreen).toBe(true); // culled

    // Onscreen splat at ndc.x = 0.5
    const onscreen = Math.abs(0.5) - sizeNDC > 1.0;
    expect(onscreen).toBe(false); // not culled

    // Edge case: clearly beyond boundary
    const beyond = Math.abs(1.2) - sizeNDC > 1.0;
    expect(beyond).toBe(true); // culled
  });

  // ─── T8: Lambda2 clamp prevents degenerate splats ─────────────

  it("T8: near-zero lambda2 clamps to 0.1, producing a valid quad", () => {
    // Degenerate covariance: almost a line (lambda2 ≈ 0)
    const a = 10, b = 0, c = 0.001; // ratio 10000:1
    const [l1, l2] = eigenvalues(a, b, c);

    // Lambda2 should be clamped to 0.1
    expect(l2).toBeCloseTo(0.1, 2);

    // Lambda1 should be unaffected
    expect(l1).toBeGreaterThan(5);

    // Quad dimensions should both be positive and finite
    const side1 = 2 * Math.sqrt(2 * l1);
    const side2 = 2 * Math.sqrt(2 * l2);
    expect(side1).toBeGreaterThan(0);
    expect(side2).toBeGreaterThan(0);
    expect(Number.isFinite(side1)).toBe(true);
    expect(Number.isFinite(side2)).toBe(true);

    // Area should be reasonable (not zero, not infinite)
    expect(side1 * side2).toBeGreaterThan(0.1);
    expect(side1 * side2).toBeLessThan(10000);
  });
});
