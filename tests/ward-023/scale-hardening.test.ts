/**
 * Ward 023 — Hardware Z-Buffer Hardening tests (CPU-side).
 *
 * GPU-rendering verificeres kun manuelt via V-gates. CPU-tests her dækker:
 *   - Point size formel (T2, T3)
 *   - Frustum cull helper (T4)
 *   - k-d tree subdivision (T5, T6)
 *   - Adaptive density throttler med mock clock (T7, T8)
 *   - Regression guard (T1)
 */

import { describe, it, expect } from "vitest";
import { computePointSize } from "../../src/render/point-size.js";
import { BatchManager, type BoundingBox } from "../../src/render/batch-manager.js";
import { cullBatch } from "../../src/render/frustum-cull.js";
import { AdaptiveDensityThrottler } from "../../src/render/adaptive-density.js";
import { extractFrustumPlanes } from "../../src/selection/frustum.js";

// ─── Tests ──────────────────────────────────────────────────────

describe("Ward 023: Hardware Z-Buffer Hardening", () => {
  // ─── T1: radix_sort_remains_bypassed_in_points_mode ───────────

  it("T1: Given: las-smoke i points-mode — When: Ward 23-ændringer applied — Then: ingen radix-sort import i smoke-bundlen", async () => {
    // Regression guard for Ward 20 T4. Vi tjekker at las-smoke.ts ikke importerer
    // nogen radix-sort modul direkte (det er hot-path indicator).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const smokeSrc = fs.readFileSync(
      path.resolve(__dirname, "../../src/app/las-smoke.ts"),
      "utf-8",
    );
    expect(smokeSrc).not.toMatch(/from\s+["'][^"']*radix-sort/);
  });

  // ─── T2: compute_point_size_clamps_to_max ─────────────────────

  it("T2: Given: clip_w meget lille (point tæt på camera) — When: computePointSize — Then: clamper til max_size_px", () => {
    const result = computePointSize(0.001, {
      baseSizePx: 2.0,
      maxSizePx: 16.0,
      densityFactor: 1.0,
      viewportPx: 1000,
    });
    expect(result).toBe(16.0);
  });

  // ─── T3: compute_point_size_minimum_one_pixel ─────────────────

  it("T3: Given: clip_w meget stor (point langt væk) — When: computePointSize — Then: clamper til min 1.0 px", () => {
    const result = computePointSize(10000.0, {
      baseSizePx: 2.0,
      maxSizePx: 16.0,
      densityFactor: 1.0,
      viewportPx: 1000,
    });
    expect(result).toBe(1.0);
  });

  it("T3b: Given: density_factor < 1.0 — When: computePointSize — Then: scales base proportionally", () => {
    // baseSizePx=4, clipW=2, density=0.5 → 4 / 2 * 0.5 = 1.0 (inside clamp range)
    const result = computePointSize(2.0, {
      baseSizePx: 4.0,
      maxSizePx: 16.0,
      densityFactor: 0.5,
      viewportPx: 1000,
    });
    expect(result).toBeCloseTo(1.0, 5);
  });

  // ─── T4: aabb_outside_frustum_skipped_by_cull ─────────────────

  it("T4: Given: AABB udenfor frustum — When: cullBatch — Then: returns true (cull)", () => {
    // Identity view-proj — frustum er NDC cube [-1, 1]³
    const identityVP = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const planes = extractFrustumPlanes(identityVP);
    // Convert FrustumPlanes (array of 4-tuples) to flat Float32Array
    const planesFlat = new Float32Array(planes.flat());

    // AABB completely outside (x = 5 to 10, way outside +X plane)
    const outsideAABB: BoundingBox = {
      min: [5, -1, -1], max: [10, 1, 1],
    };
    expect(cullBatch(outsideAABB, planesFlat)).toBe(true);

    // AABB inside frustum
    const insideAABB: BoundingBox = {
      min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5],
    };
    expect(cullBatch(insideAABB, planesFlat)).toBe(false);
  });

  // ─── T5: batch_subdivide_covers_all_points ────────────────────

  it("T5: Given: 10K random points — When: subdivide — Then: sum af batch.pointCount === 10000 (lossless)", () => {
    const N = 10_000;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) positions[i] = Math.random() * 2 - 1;

    const result = BatchManager.subdivide(positions, 2000);

    const totalInBatches = result.batches.reduce((sum, b) => sum + b.pointCount, 0);
    expect(totalInBatches).toBe(N);
    expect(result.positions.length).toBe(positions.length);
  });

  // ─── T6: kd_tree_subdivision_balances_leaves ──────────────────

  it("T6: Given: 8K uniformly distributed points — When: subdivide w/ maxPerBatch=1000 — Then: leaves balanced (max ≤ 2× median)", () => {
    const N = 8_000;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) positions[i] = Math.random() * 2 - 1;

    const result = BatchManager.subdivide(positions, 1000);
    expect(result.batches.length).toBeGreaterThan(1);

    const counts = result.batches.map(b => b.pointCount).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)]!;
    const max = counts.at(-1)!;
    expect(max).toBeLessThanOrEqual(median * 2);
  });

  // ─── T7: adaptive_density_decreases_on_low_fps ────────────────

  it("T7: Given: AdaptiveDensityThrottler med mock clock — When: 30 frames @ 50ms avg (20fps) — Then: factor() < 1.0", () => {
    let time = 0;
    const throttler = new AdaptiveDensityThrottler({
      getTime: () => time,
      slowThresholdMs: 33,
      slowWindowFrames: 30,
    });

    expect(throttler.factor()).toBe(1.0); // initial

    // Seed-frame: lader throttleren registrere starttid uden at producere
    // en falsk 0ms-delta i den efterfølgende måling. Ellers ville første
    // delta være `time - undefined` eller `time - 0`, hvilket kan skævvride
    // rolling avg afhængigt af impl.
    throttler.recordFrame();
    time += 50;

    for (let i = 0; i < 35; i++) {
      throttler.recordFrame();
      time += 50; // 50ms frame = 20fps
    }

    expect(throttler.factor()).toBeLessThan(1.0);
  });

  // ─── T8: adaptive_density_recovers_on_high_fps ────────────────

  it("T8: Given: throttled state — When: 60 frames @ 14ms avg (>70fps) — Then: factor() recovers meaningfully toward 1.0", () => {
    let time = 0;
    const throttler = new AdaptiveDensityThrottler({
      getTime: () => time,
      slowThresholdMs: 33,
      fastThresholdMs: 16,
      slowWindowFrames: 30,
      fastWindowFrames: 60,
    });

    // Seed-frame
    throttler.recordFrame();
    time += 50;
    // First: throttle down
    for (let i = 0; i < 35; i++) { throttler.recordFrame(); time += 50; }
    const throttled = throttler.factor();
    expect(throttled).toBeLessThan(1.0);

    // Then: recover with fast frames
    for (let i = 0; i < 65; i++) { throttler.recordFrame(); time += 14; }
    const recovered = throttler.factor();

    // Floor på +0.05 sikrer at recovery faktisk virker meaningfully, ikke kun
    // numerisk drift. Recovery rate er 1.05 per evaluering, så over 60 frames
    // bør vi se mindst én recovery-step.
    expect(recovered).toBeGreaterThan(throttled + 0.05);
  });
});
