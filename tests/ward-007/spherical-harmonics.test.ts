/**
 * Ward 007 — Splat Fragment Shader (Spherical Harmonics) Tests
 *
 * Tests 3D→2D Gaussian projection, conic inversion, Gaussian evaluation,
 * SH basis evaluation at degrees 0-3, alpha blending compositing, and
 * shader pipeline compilation.
 *
 * All math runs in JS (CPU reference). The GPU shader implements the same
 * formulas in WGSL. These tests prove algorithmic correctness with
 * asymmetric inputs to avoid false positives from symmetry.
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeCovariance3D,
  projectCovariance2D,
  computeConic2D,
  evaluateGaussian2D,
} from "../../src/webgpu/gaussian-math.js";
import {
  evaluateSH,
  SH_C0,
  SH_C1,
} from "../../src/webgpu/spherical-harmonics.js";
import {
  compositeBackToFront,
} from "../../src/webgpu/alpha-blend.js";
import {
  compileSplatShader,
} from "../../src/webgpu/splat-shader.js";

// ─── WebGPU Constant Stubs ──────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  STORAGE: 0x0080,
  UNIFORM: 0x0040,
  COPY_DST: 0x0008,
});

vi.stubGlobal("GPUShaderStage", {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
});

// ─── Mock Infrastructure ─────────────────────────────────────────

class MockGPUShaderModule {
  code: string;
  compilationInfo: () => Promise<{ messages: { type: string; message: string }[] }>;

  constructor(desc: { code: string }, errors?: { type: string; message: string }[]) {
    this.code = desc.code;
    this.compilationInfo = async () => ({ messages: errors ?? [] });
  }
}

function createMockGPUDevice(shaderErrors?: { type: string; message: string }[]): GPUDevice {
  return {
    createShaderModule: vi.fn((desc: { code: string }) => {
      return new MockGPUShaderModule(desc, shaderErrors);
    }),
    createRenderPipeline: vi.fn(() => ({
      label: "mock-splat-pipeline",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-layout" })),
    })),
    createPipelineLayout: vi.fn(() => ({ label: "layout" })),
  } as unknown as GPUDevice;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 007: Splat Fragment Shader (Spherical Harmonics)", () => {

  // ─── Test 1: covariance_3d_to_2d ──────────────────────────────

  describe("3D covariance projection", () => {
    it("should project rotated 3D covariance to 2D with non-zero off-diagonals", () => {
      // Given: a 30° rotation around Z-axis with asymmetric scale
      // q = [cos(π/12), 0, 0, sin(π/12)] ≈ [0.9659, 0, 0, 0.2588]
      // 30° mixes X and Y without fully swapping them
      const angle = Math.PI / 6;
      const rotation: [number, number, number, number] = [
        Math.cos(angle / 2), 0, 0, Math.sin(angle / 2),
      ];
      const scale: [number, number, number] = [1.0, 3.0, 0.5];

      // 3D covariance = R * S * S^T * R^T
      // With 45° Z-rotation + asymmetric scale, off-diagonals MUST be non-zero
      const cov3d = computeCovariance3D(rotation, scale);

      // σ_xx and σ_yy should be mixed (neither pure 1.0 nor pure 9.0)
      expect(cov3d[0]).toBeGreaterThan(1.0);
      expect(cov3d[0]).toBeLessThan(9.0);
      // Off-diagonal σ_xy must be non-zero due to rotation
      expect(Math.abs(cov3d[1])).toBeGreaterThan(0.1);
      // σ_zz is unaffected by Z-rotation
      expect(cov3d[5]).toBeCloseTo(0.25);

      // Given: a view matrix with a 30° Y-rotation (Column-Major layout).
      // Column-Major: each group of 4 is one COLUMN.
      // Row-major 30° Y-rotation: [[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]]
      // Transposed to Column-Major:
      const c = Math.cos(Math.PI / 6);
      const s = Math.sin(Math.PI / 6);
      const viewMatrix = [
        c,  0, -s, 0,   // column 0
        0,  1,  0, 0,   // column 1
        s,  0,  c, 0,   // column 2
        0,  0,  0, 1,   // column 3
      ] as const;
      const splatPos: [number, number, number] = [1, 0.5, -5];
      const focal: [number, number] = [500, 400]; // asymmetric focal lengths

      // When: we project to 2D (splat is at z=-5, well in front of camera)
      const cov2d = projectCovariance2D(cov3d, viewMatrix, splatPos, focal);

      // Then: not null (splat is in front of camera)
      expect(cov2d).not.toBeNull();

      // Then: 2D covariance has non-zero off-diagonal (rotation preserved)
      expect(cov2d!.length).toBe(3); // [a, b, c] symmetric 2×2
      expect(cov2d![0]).toBeGreaterThan(0); // σ_xx > 0
      expect(cov2d![2]).toBeGreaterThan(0); // σ_yy > 0
      expect(Math.abs(cov2d![1])).toBeGreaterThan(0); // σ_xy ≠ 0
      // Asymmetric focal lengths (500 vs 400) break X/Y symmetry
      expect(cov2d![0]).not.toBeCloseTo(cov2d![2], 0);
    });
  });

  // ─── Test 1b: conic_inversion ─────────────────────────────────

  describe("computeConic2D", () => {
    it("should correctly invert 2D covariance to conic parameters", () => {
      // Given: a known 2D covariance [a, b, c] = [4, 1, 2]
      // Matrix: [[4, 1], [1, 2]], det = 4*2 - 1*1 = 7
      // Inverse: [[2/7, -1/7], [-1/7, 4/7]]
      // Conic (A, B, C) = (c/det, -b/det, a/det) = (2/7, -1/7, 4/7)
      const cov2d: [number, number, number] = [4, 1, 2];

      // When: we compute conic parameters
      const conic = computeConic2D(cov2d);

      // Then: conic = inverse of the symmetric 2×2 matrix
      expect(conic[0]).toBeCloseTo(2 / 7, 5);  // A = c/det
      expect(conic[1]).toBeCloseTo(-1 / 7, 5); // B = -b/det
      expect(conic[2]).toBeCloseTo(4 / 7, 5);  // C = a/det

      // Verify: M * M^-1 ≈ I
      // [a b][A B]   [aA+bB  aB+bC]   [1 0]
      // [b c][B C] = [bA+cB  bB+cC] = [0 1]
      expect(cov2d[0] * conic[0] + cov2d[1] * conic[1]).toBeCloseTo(1, 5);
      expect(cov2d[1] * conic[0] + cov2d[2] * conic[1]).toBeCloseTo(0, 5);
    });
  });

  // ─── Test 2: gaussian_evaluation_correct ──────────────────────

  describe("2D Gaussian evaluation (conic form)", () => {
    it("should evaluate Gaussian with correct falloff using conic parameters", () => {
      // Given: a circular Gaussian → cov2d = [1, 0, 1]
      // Conic (inverse) = [1, 0, 1] (identity is self-inverse)
      const conic: [number, number, number] = [1, 0, 1];
      const opacity = 0.9;

      // When: we evaluate at the center (0, 0)
      // power = -0.5 * (A*dx² + 2*B*dx*dy + C*dy²) = 0
      const atCenter = evaluateGaussian2D(conic, 0, 0, opacity);
      expect(atCenter).toBeCloseTo(0.9);

      // When: we evaluate at 1 sigma away in X
      // power = -0.5 * (1*1 + 0 + 0) = -0.5
      const at1Sigma = evaluateGaussian2D(conic, 1, 0, opacity);
      expect(at1Sigma).toBeCloseTo(0.9 * Math.exp(-0.5), 2);

      // When: we evaluate at (1, 1) — diagonal
      // power = -0.5 * (1 + 0 + 1) = -1.0
      const atDiag = evaluateGaussian2D(conic, 1, 1, opacity);
      expect(atDiag).toBeCloseTo(0.9 * Math.exp(-1.0), 2);

      // When: we evaluate at 3 sigma (near zero)
      const at3Sigma = evaluateGaussian2D(conic, 3, 0, opacity);
      expect(at3Sigma).toBeLessThan(0.02);
    });
  });

  // ─── Test 3: sh_degree_0_rgb ──────────────────────────────────

  describe("SH degree 0 (DC)", () => {
    it("should produce view-independent color via DC term only", () => {
      // Given: 3 DC coefficients [r, g, b]
      // 3DGS color mapping: color_channel = SH_C0 * coeff + 0.5
      // SH_C0 ≈ 0.28209 (the Y_0^0 spherical harmonic constant)
      const dc: number[] = [0.8, 0.3, 0.5];

      // When: we evaluate from three orthogonal view directions
      const dirZ: [number, number, number] = [0, 0, 1];
      const dirX: [number, number, number] = [1, 0, 0];
      const dirY: [number, number, number] = [0, 1, 0];

      const colorZ = evaluateSH(dc, dirZ, 0);
      const colorX = evaluateSH(dc, dirX, 0);
      const colorY = evaluateSH(dc, dirY, 0);

      // Then: all directions produce identical colors (degree 0 is a constant)
      expect(colorZ[0]).toBeCloseTo(colorX[0], 4);
      expect(colorZ[1]).toBeCloseTo(colorX[1], 4);
      expect(colorZ[2]).toBeCloseTo(colorX[2], 4);
      expect(colorZ[0]).toBeCloseTo(colorY[0], 4);

      // Then: output matches the 3DGS mapping formula
      const expectedR = SH_C0 * dc[0] + 0.5;
      const expectedG = SH_C0 * dc[1] + 0.5;
      const expectedB = SH_C0 * dc[2] + 0.5;
      expect(colorZ[0]).toBeCloseTo(expectedR, 4);
      expect(colorZ[1]).toBeCloseTo(expectedG, 4);
      expect(colorZ[2]).toBeCloseTo(expectedB, 4);
    });
  });

  // ─── Test 4: sh_degree_1_view_dependent ───────────────────────

  describe("SH degree 1 (view-dependent)", () => {
    it("should modulate specific RGB channels based on view direction", () => {
      // Given: DC = zero, degree 1 coefficients designed so that:
      //   Looking from +Y adds red     (Y basis → R channel)
      //   Looking from +Z adds green   (Z basis → G channel)
      //   Looking from +X adds blue    (X basis → B channel)
      //
      // SH degree 1 basis functions: Y_1^{-1}=y, Y_1^0=z, Y_1^1=x (scaled by SH_C1)
      // Coefficients are stored as [R,G,B] per basis function.
      const coeffs: number[] = [
        0, 0, 0,        // DC (R, G, B) — neutral
        1, 0, 0,        // Y_1^{-1} (y-basis): adds Red
        0, 1, 0,        // Y_1^{0}  (z-basis): adds Green
        0, 0, 1,        // Y_1^{+1} (x-basis): adds Blue
      ];

      // When: we look from +Y → y-basis activates → Red channel boosted
      const dirY: [number, number, number] = [0, 1, 0];
      const colorY = evaluateSH(coeffs, dirY, 1);

      // When: we look from +Z → z-basis activates → Green channel boosted
      const dirZ: [number, number, number] = [0, 0, 1];
      const colorZ = evaluateSH(coeffs, dirZ, 1);

      // When: we look from +X → x-basis activates → Blue channel boosted
      const dirX: [number, number, number] = [1, 0, 0];
      const colorX = evaluateSH(coeffs, dirX, 1);

      // Then: +Y direction has the highest Red of the three
      expect(colorY[0]).toBeGreaterThan(colorZ[0]);
      expect(colorY[0]).toBeGreaterThan(colorX[0]);

      // Then: +Z direction has the highest Green
      expect(colorZ[1]).toBeGreaterThan(colorY[1]);
      expect(colorZ[1]).toBeGreaterThan(colorX[1]);

      // Then: +X direction has the highest Blue
      expect(colorX[2]).toBeGreaterThan(colorY[2]);
      expect(colorX[2]).toBeGreaterThan(colorZ[2]);

      // Verify the actual magnitude: SH_C1 * 1.0 (coeff) * 1.0 (dir component)
      // The boosted channel should be exactly SH_C1 above the DC baseline (0.5)
      expect(colorY[0]).toBeCloseTo(0.5 + SH_C1, 4);
      expect(colorZ[1]).toBeCloseTo(0.5 + SH_C1, 4);
      expect(colorX[2]).toBeCloseTo(0.5 + SH_C1, 4);
    });
  });

  // ─── Test 5: sh_degree_3_full ─────────────────────────────────

  describe("SH degree 3 (full evaluation)", () => {
    it("should evaluate all 16 basis functions with asymmetric coefficients", () => {
      // Given: 48 asymmetric coefficients — sin-based pseudo-random to break symmetry
      // This ensures each basis function contributes differently per channel
      const coeffs = Array.from({ length: 48 }, (_, i) =>
        Math.sin((i + 1) * 1.7) * 0.3,
      );

      // Use an asymmetric direction to activate all basis functions differently
      const dir: [number, number, number] = [0.8, 0.3, -0.5148]; // roughly normalised

      // When: we evaluate at degree 3
      const color = evaluateSH(coeffs, dir, 3);

      // Then: valid finite values
      expect(Number.isFinite(color[0])).toBe(true);
      expect(Number.isFinite(color[1])).toBe(true);
      expect(Number.isFinite(color[2])).toBe(true);

      // Then: RGB channels are NOT equal (asymmetric coefficients + asymmetric direction)
      expect(color[0]).not.toBeCloseTo(color[1], 2);
      expect(color[1]).not.toBeCloseTo(color[2], 2);

      // Then: degree 3 produces different result than degree 0
      const colorDeg0 = evaluateSH(coeffs, dir, 0);
      expect(color[0]).not.toBeCloseTo(colorDeg0[0], 2);

      // Then: degree 3 produces different result than degree 1
      const colorDeg1 = evaluateSH(coeffs, dir, 1);
      expect(color[0]).not.toBeCloseTo(colorDeg1[0], 2);
    });
  });

  // ─── Test 6: alpha_blending_compositing ───────────────────────

  describe("alpha blending (back-to-front compositing)", () => {
    it("should correctly composite overlapping splats using straight alpha input", () => {
      // Given: 3 splats in back-to-front order (farthest first).
      // Input uses straight (non-premultiplied) alpha. The compositeBackToFront
      // function converts to premultiplied internally:
      //   C_out = α * C_splat + (1 - α) * C_behind
      const splats = [
        { r: 1.0, g: 0.0, b: 0.0, a: 0.5 }, // red, 50% opaque (farthest)
        { r: 0.0, g: 1.0, b: 0.0, a: 0.5 }, // green, 50% opaque
        { r: 0.0, g: 0.0, b: 1.0, a: 0.8 }, // blue, 80% opaque (closest)
      ];

      // When: we composite back-to-front
      const result = compositeBackToFront(splats);

      // Then: manual calculation step by step:
      // Start: C = (0, 0, 0)
      // +red(α=0.5):   C = 0.5*(1,0,0) + 0.5*(0,0,0) = (0.5, 0, 0)
      // +green(α=0.5): C = 0.5*(0,1,0) + 0.5*(0.5,0,0) = (0.25, 0.5, 0)
      // +blue(α=0.8):  C = 0.8*(0,0,1) + 0.2*(0.25,0.5,0) = (0.05, 0.1, 0.8)
      expect(result.r).toBeCloseTo(0.05, 2);
      expect(result.g).toBeCloseTo(0.1, 2);
      expect(result.b).toBeCloseTo(0.8, 2);
    });
  });

  // ─── Test 7: sh_shader_pipeline_compiles ──────────────────────

  describe("compileSplatShader", () => {
    it("should compile a Vertex+Fragment WGSL shader without errors", async () => {
      // Given: a mock device
      const device = createMockGPUDevice();
      const format = "bgra8unorm" as GPUTextureFormat;

      // When: we compile the splat shader
      const result = await compileSplatShader(device, format);

      // Then: shader module was created with both @vertex and @fragment
      expect(device.createShaderModule).toHaveBeenCalled();
      const shaderCode = vi.mocked(device.createShaderModule).mock.calls[0][0].code;
      expect(shaderCode).toContain("@vertex");
      expect(shaderCode).toContain("@fragment");
      // Must contain SH evaluation and Gaussian/conic math
      expect(shaderCode).toContain("conic");
      expect(shaderCode).toContain("sh");

      // Render pipeline was created
      expect(device.createRenderPipeline).toHaveBeenCalled();
      expect(result.pipeline).toBeDefined();
      expect(result.shaderModule).toBeDefined();
    });

    it("should throw on shader compilation error", async () => {
      // Given: a device that reports shader errors
      const device = createMockGPUDevice([
        { type: "error", message: "unexpected token '}'" },
      ]);

      // When/Then: compilation should throw
      await expect(compileSplatShader(device, "bgra8unorm" as GPUTextureFormat))
        .rejects.toThrow(/shader.*compilation.*failed|unexpected token/i);
    });
  });
});
