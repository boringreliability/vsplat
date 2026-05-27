# Context — vsplat

## Last Updated
Ward 20 complete — 2026-05-27

## Current State
**Epic 06 LiDAR Point Cloud Pivot — Ward 20 COMPLETE.** Hardware Z-buffer point-pipeline kører end-to-end i ægte Chrome (verificeret via `points-smoke.html` med 50K tilted torus-points @ 120 FPS). Ward 20 leverede en minimal `point-list` topologi shader + depth24plus attachment + RENDER_MODE flag-mekanisme. Pivotens kerne-hypotese er bekræftet: ingen SH, ingen covariance, ingen radix-sort i hot path, og det fungerer stadig.

### Active wards (parallelt arbejde tilladt — ingen vandfald)
- **Ward 21** (LAS/LAZ Stream Ingestion) — Rust-tung, kan startes
- **Ward 24** (WebGPU API Migration & Tech Debt) — **HIGH PRIORITY**, fjerner ægte runtime-fejl i Ward 5/6/7/12 moduler; uafhængig af Ward 21 (rører kun shader-compile call sites)
- Ward 22 og 23 venter på Ward 21 og 20 (deres respektive dependencies)

### Deferred
- Ward 19 (Production Rendering for 3DGS) — koden bevares som regression-baseline under `RENDER_MODE="splats"`

### Pre-pivot baseline (Wards 1-18 complete)
18 wards komplet. First Light opnået. 184 tests (155 TS + 29 Rust). End-to-end pipeline: PLY → Rust parser (sigmoid opacity, log-space scale) → Worker bridge → GPU upload → depth key compute → global radix sort → 3DGS splat shader (covariance→conic→Gaussian falloff→SH DC color) → orbit camera. Draw budget 500K, sort-on-camera-change, FPS counter.

### Epic 06 mål
- LAS/LAZ ingestion via OPFS-streaming
- Point-pipeline med hardware Z-buffer (ingen radix-sort i hot path)
- Intensity / classification / RGB color mapping
- 20M+ points @ 30+ FPS

## Architecture Decisions Made
| Decision | Rationale | Ward |
|----------|-----------|------|
| wasm32-unknown-unknown baseline | Broadest browser compatibility, memory64 som opt-in acceleration | 1 |
| FIFO message queue over ID-correlation | Simpler, korrekt for single-threaded workers, ingen krav til worker echo | 1 |
| memory64 detection via Wasm validate | Håndkodet minimal Wasm binary med 0x05 flag — ingen runtime compilation | 1 |
| OPFS for file I/O | Undgår at holde gigabyte-filer i JS heap; synkron læsning i Worker | 2 |
| 4MB chunk size for OPFS write | Balancerer memory footprint vs. syscall overhead; Blob.slice() håndterer GC | 2 |
| SyncAccessHandle isolation | Isoleret i egen funktion da den KUN virker i dedicated Worker context | 2 |
| SoA over AoS | GPU-venligt layout, cache-effektiv iteration over millioner af splats | 3-4 |
| GPU Radix Sort | O(n) sortering, undgår CPU-GPU round-trip per frame | 6 |
| Soft delete via tags | Gratis Undo — data fjernes først ved eksport | 10 |
| Pivot fra 3DGS til LiDAR Point Cloud | SH+covariance+sort er beregningstung; LiDAR-points er opaque (hardware Z-buffer løser visibility gratis); 70% af eksisterende stack (ECS, OPFS, Worker, camera) er format-agnostisk og genbruges | Epic 06 |
| Defer Ward 19 i stedet for sletning | Ward 19's splat-rendering-arbejde bevares som regression-baseline under `RENDER_MODE="splats"` flag; samtidig spildes ingen yderligere tid på færdiggørelse | Epic 06 |

## Active Constraints
- COOP/COEP headers SKAL sættes for SharedArrayBuffer support
- Alle browser-features SKAL detekteres runtime (ingen hardcoding)
- JS må ALDRIG holde .ply filindhold i ArrayBuffer
- Sortering SKAL ske på GPU, aldrig CPU
- Delete er altid soft (tag-based) indtil eksport

## Key Metrics
| Metric | Value | Ward |
|--------|-------|------|
| Target splat count | 5M | All |
| Load budget | < 3000ms | 1-3 |
| Sort budget | < 4ms/frame | 6 |
| Render budget | < 10ms/frame | 7 |
| Selection budget | < 20ms | 9 |
| Frametime budget | < 16ms (60fps) | All |

## Known Limitations
- `createWorker()` er stadig en placeholder — rigtig Wasm Worker instantiation kræver Rust crate
- Feature detection + OPFS tests kører i Node med mocks — browser-integration test mangler
- OPFS write bruger ikke progress callbacks endnu (tilføjes i Ward 3 integration)

## What Comes Next
WDD kører ikke vandfald — wards kan tages ud af rækkefølge så længe deres dependencies er opfyldt. Nuværende valgmuligheder:

- **Ward 24** (HIGH PRIO): WebGPU API Migration — fixer runtime-fejl i Ward 5/6/7/12 + Ward 7 test-failure. Lille scope (~10 tests). `dependencies: []`
- **Ward 21**: LAS/LAZ Stream Ingestion — Rust-tung, største ward i Epic 06 (~9 tests). `dependencies: [2, 3, 15, 16, 20]` — alle opfyldt
- Ward 22 og 23 venter på 21 (data) og 20 (pipeline) — kan ikke startes endnu

### Discoverede issues (handled i Ward 24)
- `compilationInfo()` → `getCompilationInfo()` spec-rename ramte alle render-moduler
- `tests/ward-007/spherical-harmonics.test.ts` fejler pga. Ward 19's halv-port
- `wdd complete` regenererer PROGRESS.md uden at kende `deferred`-status (kosmetisk)
