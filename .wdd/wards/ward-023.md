---
ward: 23
revision: null
name: "Hardware Z-Buffer Hardening (Massive Scale)"
epic: "point-cloud-pivot"
status: "complete"
dependencies: [9, 20, 21, 22]
layer: "typescript+wgsl"
estimated_tests: 12
created: "2026-05-26"
completed: "2026-08-29"
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

### `src/webgpu/colored-point-pipeline.ts` (udvidet — IKKE Ward 20's white pipeline)
Ward 23's perspektiv-korrekt point size + clip-space cull rammer **kun** Ward 22's colored pipeline (LiDAR-modes). Ward 20's white pipeline er regression-baseline og forbliver simpel (`point_size = 1.0` implicit).

**Arkitektur-beslutning (låst i spec, ikke Gold):**
Vi skifter Ward 22's `point-list` topology til **instanced billboard-quads via triangle-list**. WGSL eksponerer ikke `point_size` (fjernet fra spec), så ægte variabel point-size kræver quad-baseret rendering.

- `primitive.topology: "triangle-list"`
- Vertex shader bruger `@builtin(vertex_index)`:
  ```wgsl
  let point_idx = vi / 6u;           // 6 vertices per quad (2 triangles)
  let corner_idx = vi % 6u;          // 0..5 selects corner offset
  let corner = QUAD_CORNERS[corner_idx]; // ±1 in (x,y)
  ```
- Perspektiv-korrekt size — alle størrelser i **pixels**, konverteres til clip-space rundt om quad-corner:
  ```
  size_px = clamp(base_size_px / clip_w * density_factor, 1.0, max_size_px)
  size_clip = size_px / viewport_px * 2.0   // factor 2 fordi NDC spænder [-1, 1]
  ```
  CPU-reference helper `computePointSize(clip_w, params): number` returnerer altid PIXELS.
- Per-vertex frustum cull: kvadratens center culles hvis `any(abs(ndc.xy) > 1.0 + size_in_ndc)`. Culled point emitterer NaN-position → GPU skipper alle 4 vertices.
- Uniform udvidet med `{ base_size_px, max_size_px, density_factor, viewport_px, _pad }` (32 bytes total med padding)

### `src/render/batch-manager.ts` (ny)
- `BatchManager.subdivide(positions: Float32Array, maxPerBatch: 250_000): Batch[]`
- **k-d tree subdivision** (longest-axis median split, max 6 niveauer = max 64 leaves). LiDAR-data er ofte fundamentalt 2D (street-scan) eller flade-domineret — k-d giver balancerede splits hvor octree ville have mange tomme blade.
- Tomme blade udelades fra output-array.
- Pr. batch: `BoundingBox { min: [x,y,z], max: [x,y,z] }`, `firstPoint: number`, `pointCount: number`.

### Render-loop batching (i `las-smoke.ts`)
- **Én delt bind group** på tværs af alle batches — samme positions/intensity/rgb/classification buffers, kun draw-range varieres.
- For hver visible batch: `pass.draw(batch.pointCount * 6, 1, batch.firstPoint * 6, 0)` (faktor 6 for triangle-list-quad-vertices).
- **Ingen `drawIndirect`** — CPU kender alle parametre, GPU-buffer-roundtrip er unødig overhead.

### `src/render/adaptive-density.ts` (ny)
- `class AdaptiveDensityThrottler` med dependency-injected `getTime: () => number`
- `recordFrame(): void` opdaterer rolling avg over 30/60 frames
- `factor(): number` returnerer aktuel density_factor (uploades til uniform)
- Sikrer T7/T8 deterministiske via mock clock

### `src/app/las-smoke.ts` (udvidet — IKKE Ward 18's main.ts)
- Stat overlay: FPS, visible batches / total batches, drawn points / total points
- Slider for `base_size_px` (0.5–4.0)
- Throttler kobles til render-loop

### `src/render/frustum-cull.ts` (ny — udvider Ward 9)
- `cullBatch(aabb: BoundingBox, planes: Float32Array): boolean`
- Returnerer `true` hvis AABB er helt udenfor frustum (skal cullles), `false` ellers
- Genbruger Ward 9's `extractFrustumPlanes` til at producere `planes` fra view-proj-matrix
- Plane-AABB-test: for hver plane, find AABB's "negative vertex" (det hjørne længst i plane-normal-retning) og test om det er bag planet

### `src/webgpu/radix-sort-*.ts` — STATUS QUO
Modulet rør **ikke**. Ward 20 bypassede allerede radix-sort i points-mode; Ward 23 ændrer ikke det design. Ward 12's radix-sort tests forbliver grønne uden ændringer. Sletning/flytning er Epic 07's beslutning.

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
   - For hver batch: test AABB mod frustum-planes (Ward 9 frustum-helper)
   - Skip `draw()`-kald for batches udenfor frustum
4. **Draw call-strategi:**
   - Direkte `pass.draw(vertexCount, 1, firstVertex, 0)` — ingen `drawIndirect`
   - CPU kender batch-params (offset, count) → ingen GPU-buffer-roundtrip nødvendig
   - `drawIndirect` ville kun give gevinst hvis GPU-compute-shader producerede draw-params (potentiel Epic 07 GPU-cull optimering)
5. **Adaptive density (anti-jank):**
   - Frame-tid måles via injiceret `getTime` (default `performance.now`)
   - Rolling avg: snit over sidste 30 frames
   - Hvis snit > 33ms: `density_factor *= 0.95`
   - Hvis snit < 16ms over 60 frames: `density_factor *= 1.05` (clamp til 1.0)
   - Shader anvender ved at droppe points hvor `hash(point_idx) > density_factor`. Hash-funktion (reference-impl):
     ```wgsl
     fn point_hash(idx: u32) -> f32 {
         return fract(sin(f32(idx) * 12.9898) * 43758.5453);
     }
     ```
     Pseudo-random men deterministisk pr. frame, giver jævn spatial dropping. Trade-off: ujævn density visuelt, men opretholder spatial coverage.
6. **Ward Boundary Contract Test:**
   - Batch-output fra `BatchManager.subdivide` skal dække ALLE input-points uden duplikater (sum af `count` = total)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `radix_sort_remains_bypassed_in_points_mode` | **Regression guard for Ward 20 T4** — sikrer Ward 23's ændringer ikke genintroducerer radix-sort i hot path |
| T2 | `compute_point_size_clamps_to_max` | CPU-reference helper: punkter meget tæt på camera (small `clip_w`): `point_size === max_size_px` |
| T3 | `compute_point_size_minimum_one_pixel` | CPU-reference (pixel-units): punkter langt væk → `point_size === 1.0` (1 pixel floor) |
| T4 | `aabb_outside_frustum_skipped_by_cull` | CPU-side `cullBatch(aabb, frustumPlanes)` returnerer `true` for AABB udenfor frustum, `false` indenfor |
| T5 | `batch_subdivide_covers_all_points` | Sum af alle batch.pointCount === input total (lossless coverage) |
| T6 | `kd_tree_subdivision_balances_leaves` | Median-split sikrer at ingen leaf indeholder > 2× medianen af andre leaves |
| T7 | `adaptive_density_decreases_on_low_fps` | `AdaptiveDensityThrottler` med mock clock: simuleret 33ms+ avg over 30 frames → `factor() < 1.0` |
| T8 | `adaptive_density_recovers_on_high_fps` | Mock clock: 16ms- avg over 60 frames efter throttling → `factor()` trender opad mod 1.0 |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Indlæs 20M+ point LAS | **Parse < 1s** (Ward 21 budget); **GPU upload < 3s** (CPU rotation re-uploads 20M × 12B = 240MB per frame ved 60fps requires staged upload). Total visible-first-frame < 5s. |
| V2 | Roter kamera frit | 30+ FPS stabilt, ingen system-hang |
| V3 | Zoom helt ind | Tætte points fylder pixels — ingen sub-pixel disco |
| V4 | Zoom helt ud | Hele sky synlig, points 1px, ingen popping |
| V5 | Pan til kant af scene | Off-screen batches skip'pet (synlig FPS-stigning) |
| V6 | Toggle "white" mode i las-smoke (regression for Ward 20) | Hvide 1px points renderer uden ændringer |

## Must NOT
- Genindføre alpha-blending i "points"-mode (depth handler visibility)
- Ændre Ward 20's white pipeline (regression-baseline forbliver simpel point-list med implicit 1px size)
- Slette eller flytte `radix-sort-*.ts` — Ward 20 har allerede bypassed dem i points-mode; sletning hører til Epic 07
- Røre `src/app/main.ts` — det er Ward 18/19's 3DGS app shell, ikke Epic 06's LiDAR-mode
- Lave one-shot draw call på > 2M vertices (driver-timeout risk)
- Brække Ward 12-tests eller Ward 22-tests

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

## Close-out (2026-08-29)

Warden lå i `gold` med 9 grønne tests, men var **ikke færdig**. To ting blev fundet ved gennemgangen mod spec'en før godkendelse:

### 1. Batching var aldrig koblet til render-loopet

`BatchManager` og `cullBatch` var unit-testede, men ingen af dem blev kaldt af `las-smoke.ts`. Render-loopet tegnede stadig hele scenen med ét `pass.draw(currentPointCount * 6)`, og HUD'en sagde det selv: `"n/a (batches CPU-tested, not smoke-integrated)"`. Det er præcis den "afkoblede funktion" Epic 06's mål advarer mod — og ét 20M-vertex draw call er selve den driver-timeout warden blev skrevet for at fjerne.

Manglende led var et planlægningslag. Tilføjet som `src/render/draw-plan.ts`:

- `planBatchDraws(batches, planes)` → synlige ranges + tællere, med **sammenlægning af nabo-batches** (8 synlige naboer bliver til ét draw call, ikke otte)
- `drawArgsFor(range)` → `{ vertexCount, firstVertex }` med spec'ens faktor 6

Render-loopet bruger nu én delt bind group og ét `draw()` per range, og HUD'en viser `synlige/total batches · tegnede/total punkter · antal draws`.

**To fælder der blev lukket undervejs:**

- **Attributter fulgte ikke permutationen.** `subdivide()` pakker positions om og returnerer en `permutation`, men intensity/rgb/classification blev uploadet i original rækkefølge — hvert punkt ville have fået et andet punkts farve. Tilføjet `permuteAttribute()` + T10.
- **AABB'erne ville være forældede efter første frame.** Smoke-siden roterer punkterne på CPU'en, så batchenes AABB'er (beregnet ved upload) passer ikke til de roterede positioner. Løst ved at folde rotationen ind i frustummet i stedet: planes udtrækkes fra `VIEW_PROJ · rotY(angle)`, og batchene testes i deres egen uroterede model-space. `VIEW_PROJ` var hardkodet i WGSL-strengen og er nu eksporteret som `VIEW_PROJ_MATRIX`, hvorfra shader-literalen genereres — CPU og GPU kan ikke længere divergere.

### 2. CPU-referencen og shaderen var uenige om `density_factor`

`point-size.ts` hævdede i sin docstring at matche WGSL, og gangede størrelsen med `density_factor`. Shaderen gjorde det ikke — den bruger `density_factor` til at droppe punkter (`hash(idx) > factor`), som spec'ens §5 foreskriver. Spec'en modsiger sig selv: §2 og Outputs skriver faktoren ind i størrelsesformlen, §5 lader den styre dropping.

Rettet så CPU-referencen matcher shaderen, altså **uden** density i størrelsen. Begrundelse: dropper man halvdelen af punkterne for at spare fill rate, vil man have de overlevende mindst lige så store — skrumper man dem også, åbner throttling huller dobbelt så hurtigt. T3b er skrevet om til at fastholde at de to er enige.

### Tests

12 grønne (spec'ens T1-T8 + T3b, T9, T9b, T10). Fuld suite: 205 TypeScript + 46 Rust.

De tre nye tests er dem der ville have fanget afkoblingen: T9/T9b tester at planlægningen faktisk vælger og slår batches sammen, T10 at attributter følger deres punkter.

### Visual Verification — mangler menneske, med ét forbehold

V1 (20M punkter), V2 (30+ FPS under rotation) og V3 (zoom ind) kræver GPU og store filer.

**V3 kan ikke verificeres i smoke-siden som den ser ud nu.** Dens `VIEW_PROJ` er identitet med en z-remap, og positionerne er forud-normaliseret til [-1, 1], så `clip_w` er altid 1.0. Perspektiv-korrekt størrelse er dermed en no-op der: alle punkter får `base_size_px`. Formlen og dens CPU-reference er korrekte og testede, men de får først effekt når en rigtig perspektiv-kamera-matrix kommer ind i point-stien. Det hører til `main.ts`-integrationen, ikke her.
