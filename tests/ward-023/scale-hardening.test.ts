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
import { drawArgsFor, planBatchDraws } from "../../src/render/draw-plan.js";
import { permuteAttribute } from "../../src/render/batch-manager.js";
import { BatchManager, type BoundingBox } from "../../src/render/batch-manager.js";
import { cullBatch, flattenPlanes } from "../../src/render/frustum-cull.js";
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

  it("T3b: Given: density_factor < 1.0 — When: computePointSize — Then: størrelsen er upåvirket (density dropper punkter, den skrumper dem ikke)", () => {
    // Shaderen bruger density_factor til at droppe punkter (hash > factor),
    // ikke til at skalere størrelsen. Ville den også skrumpe de overlevende,
    // åbnede throttling huller dobbelt så hurtigt. CPU-referencen skal spejle
    // shaderen præcist — den er referencen, ikke en anden mening.
    const params = { baseSizePx: 4.0, maxSizePx: 16.0, viewportPx: 1000 };
    const throttled = computePointSize(2.0, { ...params, densityFactor: 0.5 });
    const full = computePointSize(2.0, { ...params, densityFactor: 1.0 });
    expect(throttled).toBeCloseTo(2.0, 5); // 4 / 2, ingen density-faktor
    expect(throttled).toBe(full);
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

  // ─── T9: batch_draw_plan_matches_visible_batches ──────────────

  it("T9: Given: batches hvor nogle er udenfor frustum — When: planBatchDraws — Then: kun synlige tegnes, og naboer slås sammen", () => {
    // Identity view-proj → frustum er NDC-kuben [-1, 1]³
    const identityVP = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const planes = flattenPlanes(extractFrustumPlanes(identityVP));

    // NB: WebGPU's near plane ligger ved z = 0 (dybde ∈ [0, 1]), så en AABB med
    // negativ z ligger BAG kameraet og culles korrekt.
    const box = (
      min: [number, number, number], max: [number, number, number],
    ): BoundingBox => ({ min, max });
    const batches: Batch[] = [
      { firstPoint: 0, pointCount: 100, aabb: box([-0.5, -0.5, 0.1], [-0.1, -0.1, 0.4]) },
      { firstPoint: 100, pointCount: 200, aabb: box([0.1, 0.1, 0.1], [0.5, 0.5, 0.4]) },
      { firstPoint: 300, pointCount: 400, aabb: box([50, 50, 50], [60, 60, 60]) },   // udenfor
      { firstPoint: 700, pointCount: 50, aabb: box([-0.2, -0.2, 0.2], [0.2, 0.2, 0.6]) },
    ];

    const plan = planBatchDraws(batches, planes);

    expect(plan.totalBatches).toBe(4);
    expect(plan.visibleBatches).toBe(3);
    expect(plan.totalPoints).toBe(750);
    expect(plan.drawnPoints).toBe(350);
    // Batch 0+1 er sammenhængende og slås sammen; batch 3 står alene
    expect(plan.ranges).toEqual([
      { firstPoint: 0, pointCount: 300 },
      { firstPoint: 700, pointCount: 50 },
    ]);
    // 6 vertices per punkt i triangle-list-quad-pipelinen
    expect(drawArgsFor(plan.ranges[0]!)).toEqual({ vertexCount: 1800, firstVertex: 0 });
    expect(drawArgsFor(plan.ranges[1]!)).toEqual({ vertexCount: 300, firstVertex: 4200 });
  });

  it("T9b: Given: intet culles — When: planBatchDraws — Then: hele scenen dækkes af sammenhængende ranges", () => {
    const identityVP = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const planes = flattenPlanes(extractFrustumPlanes(identityVP));
    const batches: Batch[] = Array.from({ length: 8 }, (_, i) => ({
      firstPoint: i * 1000,
      pointCount: 1000,
      aabb: { min: [-0.5, -0.5, 0.1], max: [0.5, 0.5, 0.9] },
    }));

    const plan = planBatchDraws(batches, planes);

    expect(plan.visibleBatches).toBe(8);
    expect(plan.drawnPoints).toBe(8000);
    // Alle 8 er naboer → ét enkelt draw call, ikke otte
    expect(plan.ranges).toEqual([{ firstPoint: 0, pointCount: 8000 }]);
  });

  // ─── T10: permutation_keeps_attributes_with_their_points ──────

  it("T10: Given: subdivide ompakker positions — When: permuteAttribute — Then: hvert punkt beholder sin egen attribut", () => {
    // 12 punkter langs X i omvendt rækkefølge, så subdivide GARANTERET ompakker.
    const n = 12;
    const positions = new Float32Array(n * 3);
    const intensity = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = n - i;      // x falder → k-d split sorterer om
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      intensity[i] = 1000 + i;       // unik markør per punkt
    }

    const result = BatchManager.subdivide(positions, 3);
    const permuted = permuteAttribute(intensity, result.permutation, 1);

    expect(result.positions).not.toEqual(positions); // sanity: der ER ompakket
    for (let i = 0; i < n; i++) {
      // Punktets x-koordinat identificerer det entydigt; dets intensity skal følge med
      const x = result.positions[i * 3]!;
      const originalIndex = n - x;
      expect(permuted[i]).toBe(1000 + originalIndex);
    }
  });
});
