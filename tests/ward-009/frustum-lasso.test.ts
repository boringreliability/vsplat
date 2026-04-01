/**
 * Ward 009 — Frustum Culling & Hit Testing (Lasso) Tests
 *
 * Tests frustum plane extraction, culling, screen projection, point-in-polygon
 * hit testing (including boundary contract), lasso selection integration,
 * and performance at scale.
 *
 * All math is CPU reference (TypeScript). Frustum planes are extracted
 * from a ViewProjection matrix. Point-in-polygon uses ray-casting algorithm.
 *
 * Strict boundary contract: All points exactly on an edge or vertex are
 * considered OUTSIDE (false).
 */

import { describe, it, expect } from "vitest";
import {
  extractFrustumPlanes,
  isPointInFrustum,
} from "../../src/selection/frustum.js";
import {
  pointInPolygon,
} from "../../src/selection/polygon.js";
import {
  lassoSelect,
  projectToScreen,
} from "../../src/selection/lasso.js";
import { perspectiveMatrix, lookAtMatrix } from "../../src/camera/math.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** Multiply two Column-Major 4×4 matrices: C = A * B */
function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Create a standard VP matrix: camera at (0,0,5) looking at origin */
function createTestVP(): Float32Array {
  const P = perspectiveMatrix(Math.PI / 4, 16 / 9, 0.1, 100);
  const V = lookAtMatrix([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  return mulMat4(P, V);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 009: Frustum Culling & Hit Testing (Lasso)", () => {

  // ─── Test 1: frustum_planes_extraction ────────────────────────

  describe("extractFrustumPlanes", () => {
    it("should extract 6 normalised frustum planes that classify points correctly", () => {
      const vp = createTestVP();

      // When: we extract frustum planes
      const planes = extractFrustumPlanes(vp);

      // Then: we get 6 planes (left, right, bottom, top, near, far)
      expect(planes.length).toBe(6);

      // Each plane is [a, b, c, d] — the normal (a,b,c) should be unit-length
      for (const plane of planes) {
        expect(plane.length).toBe(4);
        const len = Math.sqrt(plane[0] ** 2 + plane[1] ** 2 + plane[2] ** 2);
        expect(len).toBeCloseTo(1, 2);
      }

      // Behavioural test: a point at the origin (in front of camera) must be
      // on the positive side of ALL 6 planes (i.e. inside the frustum).
      for (let i = 0; i < 6; i++) {
        const [a, b, c, d] = planes[i];
        const dist = a * 0 + b * 0 + c * 0 + d; // origin
        expect(dist).toBeGreaterThan(0);
      }
    });
  });

  // ─── Test 2: frustum_cull_outside ─────────────────────────────

  describe("frustum cull outside", () => {
    it("should reject points clearly outside the frustum", () => {
      const vp = createTestVP();
      const planes = extractFrustumPlanes(vp);

      expect(isPointInFrustum(planes, 100, 0, 0)).toBe(false);   // far right
      expect(isPointInFrustum(planes, -100, 0, 0)).toBe(false);  // far left
      expect(isPointInFrustum(planes, 0, 100, 0)).toBe(false);   // far above
      expect(isPointInFrustum(planes, 0, 0, 200)).toBe(false);   // behind camera
      expect(isPointInFrustum(planes, 0, 0, -200)).toBe(false);  // beyond far plane
    });
  });

  // ─── Test 3: frustum_cull_inside ──────────────────────────────

  describe("frustum cull inside", () => {
    it("should accept points inside the frustum", () => {
      const vp = createTestVP();
      const planes = extractFrustumPlanes(vp);

      expect(isPointInFrustum(planes, 0, 0, 0)).toBe(true);
      expect(isPointInFrustum(planes, 0.5, 0.3, 0)).toBe(true);
      expect(isPointInFrustum(planes, -0.5, -0.3, -1)).toBe(true);
    });
  });

  // ─── Test 3b: projectToScreen ─────────────────────────────────

  describe("projectToScreen", () => {
    it("should project center-of-view to viewport center", () => {
      const vp = createTestVP();
      const viewport: [number, number] = [800, 600];

      // Origin is directly in front of camera at (0,0,5)
      const center = projectToScreen(vp, [0, 0, 0], viewport);
      expect(center).not.toBeNull();
      expect(center![0]).toBeCloseTo(400, 0); // viewport center X
      expect(center![1]).toBeCloseTo(300, 0); // viewport center Y
    });

    it("should map +X world offset to larger screen X", () => {
      const vp = createTestVP();
      const viewport: [number, number] = [800, 600];

      const center = projectToScreen(vp, [0, 0, 0], viewport)!;
      const right = projectToScreen(vp, [1, 0, 0], viewport)!;

      expect(right).not.toBeNull();
      expect(right[0]).toBeGreaterThan(center[0]); // +X world → larger screen X
    });

    it("should return null for points behind the camera", () => {
      const vp = createTestVP();
      const viewport: [number, number] = [800, 600];

      // Camera is at (0,0,5) looking toward origin. Z=200 is behind the camera.
      const behind = projectToScreen(vp, [0, 0, 200], viewport);
      expect(behind).toBeNull();
    });
  });

  // ─── Test 4: point_in_polygon_inside ──────────────────────────

  describe("pointInPolygon inside", () => {
    it("should detect points inside a polygon", () => {
      const triangle: [number, number][] = [
        [0, 0], [10, 0], [5, 10],
      ];

      expect(pointInPolygon(5, 3, triangle)).toBe(true);
      expect(pointInPolygon(1, 0.5, triangle)).toBe(true);

      // Concave L-shaped polygon
      const lShape: [number, number][] = [
        [0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10],
      ];
      expect(pointInPolygon(8, 2, lShape)).toBe(true);  // bottom-right arm
      expect(pointInPolygon(2, 8, lShape)).toBe(true);  // top-left arm
    });
  });

  // ─── Test 5: point_in_polygon_outside + boundary ──────────────

  describe("pointInPolygon outside and boundary", () => {
    it("should reject points outside a polygon", () => {
      const triangle: [number, number][] = [
        [0, 0], [10, 0], [5, 10],
      ];

      expect(pointInPolygon(-1, -1, triangle)).toBe(false);
      expect(pointInPolygon(15, 5, triangle)).toBe(false);
      expect(pointInPolygon(5, 15, triangle)).toBe(false);

      // Concave notch (inside bounding box, outside polygon)
      const lShape: [number, number][] = [
        [0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10],
      ];
      expect(pointInPolygon(8, 8, lShape)).toBe(false);
    });

    it("should treat points exactly ON any edge or vertex as outside (boundary contract)", () => {
      // Boundary contract: ALL edges and vertices are OUTSIDE.
      // This avoids double-counting at shared polygon edges in mesh-like selections.
      const square: [number, number][] = [
        [0, 0], [10, 0], [10, 10], [0, 10],
      ];

      // Bottom edge (y=0)
      expect(pointInPolygon(5, 0, square)).toBe(false);

      // Top edge (y=10)
      expect(pointInPolygon(5, 10, square)).toBe(false);

      // Left edge (x=0)
      expect(pointInPolygon(0, 5, square)).toBe(false);

      // Right edge (x=10)
      expect(pointInPolygon(10, 5, square)).toBe(false);

      // All four vertices
      expect(pointInPolygon(0, 0, square)).toBe(false);
      expect(pointInPolygon(10, 0, square)).toBe(false);
      expect(pointInPolygon(10, 10, square)).toBe(false);
      expect(pointInPolygon(0, 10, square)).toBe(false);
    });

    it("should accept points epsilon-inside an edge (not over-aggressive boundary)", () => {
      const square: [number, number][] = [
        [0, 0], [10, 0], [10, 10], [0, 10],
      ];

      // (5, 0.0001) is just barely inside the bottom edge — must be INSIDE
      expect(pointInPolygon(5, 0.0001, square)).toBe(true);

      // (5, 0) is exactly ON the bottom edge — must be OUTSIDE (boundary contract)
      expect(pointInPolygon(5, 0, square)).toBe(false);
    });
  });

  // ─── Test 6: lasso_select_marks_entities ──────────────────────

  describe("lassoSelect", () => {
    it("should select frustum-visible splats inside lasso with zero-allocation output", () => {
      // Given: 5 splats at known positions
      const positions = new Float32Array([
        0, 0, 0,        // splat 0: center
        0.5, 0.3, 0,    // splat 1: slightly off-center
        5, 5, 0,         // splat 2: far off to the side
        0, 0, 200,       // splat 3: behind camera (z=200, camera at z=5)
        -0.2, -0.1, 0,  // splat 4: near center
      ]);

      const vp = createTestVP();
      const viewport: [number, number] = [800, 600];

      // First: verify screen projections to prove our lasso geometry is correct
      const screen0 = projectToScreen(vp, [0, 0, 0], viewport)!;
      const screen1 = projectToScreen(vp, [0.5, 0.3, 0], viewport)!;
      const screen2 = projectToScreen(vp, [5, 5, 0], viewport);
      const screen3 = projectToScreen(vp, [0, 0, 200], viewport);
      const screen4 = projectToScreen(vp, [-0.2, -0.1, 0], viewport)!;

      // Splat 3 is behind camera → null
      expect(screen3).toBeNull();

      // Splats 0, 1, 4 should be near viewport center
      expect(screen0[0]).toBeCloseTo(400, -1);
      expect(screen0[1]).toBeCloseTo(300, -1);

      // Build lasso from projected coordinates of splat 0
      const lasso: [number, number][] = [
        [screen0[0] - 50, screen0[1] - 50],
        [screen0[0] + 100, screen0[1] - 50],
        [screen0[0] + 100, screen0[1] + 100],
        [screen0[0] - 50, screen0[1] + 100],
      ];

      // Verify: splats 1 and 4 are INSIDE the lasso box
      expect(screen1[0]).toBeGreaterThan(screen0[0] - 50);
      expect(screen1[0]).toBeLessThan(screen0[0] + 100);
      expect(screen1[1]).toBeGreaterThan(screen0[1] - 50);
      expect(screen1[1]).toBeLessThan(screen0[1] + 100);

      expect(screen4[0]).toBeGreaterThan(screen0[0] - 50);
      expect(screen4[0]).toBeLessThan(screen0[0] + 100);

      // Verify: splat 2 is OUTSIDE the lasso box (far off-screen or beyond box)
      if (screen2 !== null) {
        const outsideX = screen2[0] < screen0[0] - 50 || screen2[0] > screen0[0] + 100;
        const outsideY = screen2[1] < screen0[1] - 50 || screen2[1] > screen0[1] + 100;
        expect(outsideX || outsideY).toBe(true);
      }

      // When: we run lasso selection (zero-allocation: pre-allocated output buffer)
      const outIndices = new Uint32Array(5); // max possible = splat count
      const selectedCount = lassoSelect(positions, vp, viewport, lasso, outIndices);

      // Then: exactly 3 splats selected (0, 1, 4)
      expect(selectedCount).toBe(3);
      const selected = Array.from(outIndices.subarray(0, selectedCount)).sort();
      expect(selected).toEqual([0, 1, 4]);
    });
  });

  // ─── Test 7: lasso_performance_500k ───────────────────────────

  describe("lasso performance (500K)", () => {
    it("should select among 500K splats in under 200ms on CPU reference", () => {
      // Given: 500K splats distributed in a cube [-5, 5]
      // Scaled down from 5M for CPU. GPU target is <20ms for 5M.
      // Budget 200ms is conservative enough for CI stability while still
      // catching O(n²) or O(n·m²) algorithmic regressions.
      const count = 500_000;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
      }

      const vp = createTestVP();
      const viewport: [number, number] = [1920, 1080];

      // Lasso: center quarter of the screen
      const lasso: [number, number][] = [
        [480, 270], [1440, 270], [1440, 810], [480, 810],
      ];

      // Pre-allocated output buffer (zero-allocation contract)
      const outIndices = new Uint32Array(count);

      // When: we time the selection
      const start = performance.now();
      const selectedCount = lassoSelect(positions, vp, viewport, lasso, outIndices);
      const elapsed = performance.now() - start;

      // Then: completes within CPU budget
      expect(elapsed).toBeLessThan(200);
      expect(selectedCount).toBeGreaterThan(0);
      expect(selectedCount).toBeLessThan(count);
    });
  });
});
