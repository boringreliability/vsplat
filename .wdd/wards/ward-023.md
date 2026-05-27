---
ward: 23
revision: null
name: "Hardware Z-Buffer Hardening (Massive Scale)"
epic: "point-cloud-pivot"
status: "planned"
dependencies: [9, 20, 21, 22]
layer: "typescript+wgsl"
estimated_tests: 8
created: "2026-05-26"
completed: null
---
# Ward 023: Hardware Z-Buffer Hardening (Massive Scale)

## Scope
Ward 20-22 har bevist at hele point-pipelinen fungerer; nu bringer vi den til 20M+ punkter med stabil 30+ FPS. Tre arbejdsområder: (1) endeligt fjerne GPU radix-sort, da hardware depth-test gør den overflødig, (2) introducere perspektiv-korrekt og density-aware point size, og (3) implementere chunked draw-batching, så vi ikke har ét enkelt draw call på 20M vertices (drivere kan timeout). Dette ward er det der afgør om vsplat 2.0 er produktionsklar som LiDAR-viewer.

## Inputs
- Ward 20: point-pipeline med depth-stencil
- Ward 21: SoA-buffers fra LAS-ingestion
- Ward 22: color-ramp mapping
- Ward 9: frustum culling (genbruges som CPU-side coarse cull pr. batch)
- Ward 19: lessons learned om vertex shader culling i clip-space

## Outputs
### `src/webgpu/point-shader.ts` (udvidet)
- Perspektiv-korrekt point size: `point_size_px = base_size_world / clip_w` clampet til `[1.0, max_size_px]`
- Per-vertex clip-space frustum cull: `if (any(abs(ndc.xyz) > 1.0)) { /* emit zero-size point */ }`
- Density-aware sizing: uniform `{ density_factor }` baseret på scene-bounds vs viewport

### `src/webgpu/point-pipeline.ts` (udvidet)
- Batch-rendering: `drawIndirect` med indirect buffer pr. batch (200K-500K points/batch)
- Bind group cache for at undgå allocation pr. batch

### `src/webgpu/radix-sort.ts` (slettet eller flyttet)
- Modulet flyttes til `src/webgpu/_archived/radix-sort.ts` med kommentar
- Alle Ward 12-tests forbliver grønne via separat compile-target eller markeres som "splats-only"
- `main.ts` har ingen reference til radix-sort i "points"-mode

### `src/render/batch-manager.ts` (ny)
- `BatchManager.subdivide(positions: Float32Array, maxPerBatch: number): Batch[]`
- Bruger spatial subdivision (octree-niveau 2 = 64 batches max for 20M points)
- Pr. batch: `BoundingBox`, `offset`, `count`
- Brugt af render-loop til at filtrere batches mod camera frustum CPU-side

### `src/app/main.ts` (udvidet)
- Stat overlay: FPS, visible batches / total batches, drawn points / total points
- Adaptive throttling: hvis FPS < 25, reducer `density_factor` for at vise færre points dynamisk

## Specification
1. **Hvorfor depth-test erstatter sort:**
   - Gaussian splats skal alpha-blendes back-to-front → kræver sortering
   - LiDAR points er opaque → hardware depth-test (`depthCompare: "less"`) løser visibility på shader-niveau
   - Dette eliminerer hele compute-pass + ~24 dispatches pr. frame
2. **Point size formel:**
   - `point_size = clamp(base_size / clip_w * density_factor, 1.0, max_size)`
   - `base_size` opdateres pr. frame fra UI slider (0.5–4.0)
   - `density_factor` opdateres adaptivt (se §5)
3. **CPU-side coarse cull:**
   - For hver batch: test AABB mod frustum-planes (Ward 9 frustum kode)
   - Skip `drawIndirect` for batches udenfor frustum
4. **`drawIndirect` parametre:**
   - Indirect buffer pr. batch indeholder `{vertexCount, instanceCount=1, firstVertex, firstInstance=0}`
   - GPU-side validation: `vertexCount` ≤ `batch.count`
5. **Adaptive density (anti-jank):**
   - Frame-tid måles via `performance.now()` diff
   - Hvis snit-frame-tid > 33ms over 30 frames: `density_factor *= 0.95`
   - Hvis snit-frame-tid < 16ms over 60 frames: `density_factor *= 1.05` (op til 1.0)
6. **Ward Boundary Contract Test:**
   - Batch-output fra `BatchManager.subdivide` skal dække ALLE input-points uden duplikater (sum af `count` = total)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `radix_sort_not_invoked_in_points_mode` | "points"-mode render loop: 0 calls til radix-sort modul |
| T2 | `point_size_clamps_to_max` | Punkter meget tæt på camera: `point_size === max_size_px` |
| T3 | `point_size_minimum_one_pixel` | Punkter langt væk: `point_size === 1.0` |
| T4 | `clip_space_cull_zeroes_offscreen_points` | Vertex med `abs(ndc.xy) > 1.1`: `point_size === 0` |
| T5 | `batch_subdivide_covers_all_points` | Sum af alle batch.count === input total (lossless) |
| T6 | `frustum_culled_batch_skips_draw` | Batch udenfor frustum: ingen `drawIndirect`-call |
| T7 | `adaptive_density_decreases_on_low_fps` | Simuleret 20fps over 30 frames: `density_factor < 1.0` |
| T8 | `adaptive_density_recovers_on_high_fps` | Simuleret 60fps over 60 frames efter throttling: `density_factor` trender opad |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Indlæs 20M+ point LAS | Render starter < 5 sekunder efter parse done |
| V2 | Roter kamera frit | 30+ FPS stabilt, ingen system-hang |
| V3 | Zoom helt ind | Tætte points fylder pixels — ingen sub-pixel disco |
| V4 | Zoom helt ud | Hele sky synlig, points 1px, ingen popping |
| V5 | Pan til kant af scene | Off-screen batches skip'pet (synlig FPS-stigning) |
| V6 | Toggle "splats"-mode (regression) | Ward 19's 142K cactus virker stadig |

## Must NOT
- Genindføre alpha-blending i "points"-mode (depth handler visibility)
- Behold radix-sort kald i "points"-render loop
- Lave one-shot draw call på > 2M vertices (driver-timeout risk)
- Brække Ward 12-tests (radix-sort tests skal fortsat være grønne)

## Must DO
- Fjern radix-sort fra hot path i "points"-mode
- Implementér perspektiv-korrekt og density-aware point size
- Implementér CPU-side frustum cull pr. batch
- Implementér adaptive density throttling
- Bevis 30+ FPS på 20M+ points i browser
- Opdatér `.wdd/CONTEXT.md` med "default render mode = points"

## Verification
- T1-T8 grønne i Vitest
- V1-V6 visuelt verificeret med reel 20M+ LAS-fil (oplyst kilde, fx Open Topography)
- Performance-benchmark dokumenteret i `docs/lidar-perf-baseline.md` (referencemaskine: spec'd)
- QA1 godkender afkoblings-niveauet (er splats-mode reelt død kode efter dette ward? Eller skal Epic 07 fjerne den helt?)

## Open Questions for QA1
- Skal vi beholde "splats"-mode for længere, eller markere den til sletning i Epic 07?
- Skal `BatchManager` bruge en eksisterende octree-impl, eller skal Ward 23 inkludere en minimal egen?
- Er adaptive density acceptabel UX, eller foretrækker brugeren konsekvent men lavere baseline-density?
