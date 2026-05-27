# Context — vsplat

## Last Updated
Ward 21 complete — 2026-05-27

## Current State
**Epic 06 LiDAR Point Cloud Pivot — LAS-ingestion live.** Tre wards complete:

- **Ward 20**: hardware Z-buffer point-pipeline + `RENDER_MODE` flag (50K torus @ 120 FPS)
- **Ward 24**: WebGPU API migration på 4 moduler (`getCompilationInfo`)
- **Ward 21**: LAS streaming parser i Rust + FFI + `LasBridge` worker bridge. Verificeret med syntetisk PDRF 3 helix @ 28M points/sekund (17× over budget). LAZ-filer detekteres og afvises med klar fejlbesked.

Smoke-test `las-smoke.html` viser end-to-end pipeline: ArrayBuffer → Wasm parser → FFI → GPU → Ward 20's point-pipeline. Drag-drop af .las filer + syntetisk generator-knap.

### Active wards (parallelt arbejde tilladt — ingen vandfald)
- **Ward 22** (Intensity Color-Ramp Mapping) — dependencies opfyldt (20, 21)
- **Ward 25** (LAZ Decompression) — afdækket som **højværdi** efter Ward 21 smoke: alle reelle test-filer var .laz, ikke .las. USGS/Open Topography/NOAA distribuerer kun LAZ. Ward 25 bør prioriteres højt hvis vi vil have ægte brugsværdi.

### Blocked
- Ward 23 (20M scale) venter på 22

### Deferred
- Ward 19 (Production Rendering for 3DGS) — koden bevares som regression-baseline under `RENDER_MODE="splats"`

### Known Limitations
- `src/errors/memory-pressure.ts:checkSceneMemory()` estimerer ~236B/element (3DGS-format). For LiDAR-points (~18B/element) er thresholden ekstremt konservativ — store LAS-filer vil tripppe den unødigt. Bør revisiteres når LAS+LAZ integration når `main.ts`.
- LAS-smoke kører Wasm direkte i main thread (ikke Worker). Produktions-integration via `LasBridge` mangler `main.ts`-binding (kan være Ward 22's afsluttende step eller separat micro-ward).

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
To valgmuligheder (kan tages parallelt):

- **Ward 25** (LAZ Decompression) — anbefalet næste. Ward 21's smoke afslørede at ægte brugsdata næsten kun findes som .laz. Tre strategier: `laz-rs` crate på wasm32 (lavrisiko), manuel port, eller `laz-perf` via JS. ~1-3 dage afhængigt af strategi.
- **Ward 22** (Intensity Color-Ramp Mapping) — TypeScript+WGSL. Tilføjer color-ramp texture og udvider Ward 20's bind group. ~1-2 dage.

### Resolved tech debt
- ✅ Ward 24: `compilationInfo()` → `getCompilationInfo()` på 4 moduler
- ✅ Ward 21: LAZ silently-strip bug — nu eksplicit `LazCompressed` error variant
- 🟡 `wdd complete` regenererer PROGRESS.md uden at kende `deferred`-status — kræver manuel patch efter hver complete
