# Context — vsplat

## Last Updated
Ward 23 + 25 complete — 2026-08-29

## Current State
**Epic 06 LiDAR Point Cloud Pivot — alle wards complete, men epic'en er det ikke.** Seks wards:

- **Ward 20**: hardware Z-buffer point-pipeline + `RENDER_MODE` flag
- **Ward 24**: WebGPU API migration på 4 moduler
- **Ward 21**: LAS streaming parser (28M points/sekund parse-rate)
- **Ward 22**: Color ramp mapping (Viridis/Inferno/Grayscale/Elevation/Classification/RGB direct)
- **Ward 23**: batched draws med per-batch frustum cull + adaptive density
- **Ward 25**: LAZ-dekomprimering via `laz-rs` — LAS og LAZ deler én indgang

Smoke-test verificeret på Velodyne real-world LiDAR: **3.4M points @ 120 FPS i Inferno-mode**. Power lines, vejmarkeringer og bygninger synlige via intensity-baseret farve. PDRF 1/2/3 håndteres. Color ramps swapper øjeblikkeligt mellem modes uden FPS-tab.

**Ward 25 fjerner den største brugsspærring i Epic 06.** Ward 21's smoke-test viste at alle brugerens testfiler var `.laz`, ingen `.las` — motoren kunne altså ikke åbne de data den var bygget til. USGS, Open Topography og NOAA distribuerer stort set kun LAZ. Den workaround er væk: `.laz` droppes nu direkte i `las-smoke.html`.

**Ward 23 blev lukket efter en reel færdiggørelse, ikke et stempel.** Den lå i `gold` med grønne tests, men `BatchManager` og `cullBatch` var aldrig koblet til render-loopet — smoke-siden tegnede stadig alt i ét draw call. Manglende led var `src/render/draw-plan.ts`. Undervejs blev to fælder lukket: attributter fulgte ikke `subdivide()`'s permutation (hvert punkt ville have fået et andet punkts farve), og batchenes AABB'er ville være forældede under CPU-rotation (nu foldes rotationen ind i frustummet i stedet). Se ward-023.md's close-out.

**Epic 06's completion criteria er dog IKKE opfyldt**, selvom alle dens wards er complete. To af dem står åbne:
- *"En fuld LAS/LAZ fil kan parses via OPFS og uploade data direkte til WebGPU-buffers uden mellemliggende kopier i JS"* — smoke-siden holder hele filen i en JS `ArrayBuffer`, hvilket modsiger projektets egen constraint. `wasm-worker.ts` har desuden ingen LAS-håndtering: Ward 21's bridge sender `las-begin`/`las-chunk`/`las-end` ud i ingenting.
- *"Scenen kan visualisere over 20 millioner punkter"* — `checkSceneMemory()` afviser 20M punkter længe før GPU'en gør.

### Active wards
- **Ward 26** (LiDAR Production Path) — `status: red`. Flytter LiDAR-stien ind i `main.ts` med den rigtige I/O-model og lukker de to huller ovenfor. 10 tests skrevet, alle røde. Afventer QA1-gaten.

### Deferred
- Ward 19 (Production Rendering for 3DGS) — koden bevares som regression-baseline under `RENDER_MODE="splats"`

### Known Limitations
- `src/errors/memory-pressure.ts:checkSceneMemory()` estimerer ~236B/element (3DGS-format). For LiDAR-points (~18B/element) er thresholden ekstremt konservativ — store LAS-filer vil tripppe den unødigt. Bør revisiteres når LAS+LAZ integration når `main.ts`. **LAZ skærper det:** vi holder nu også de komprimerede bytes i Wasm-memory under decode.
- LAS-smoke kører Wasm direkte i main thread (ikke Worker). Produktions-integration via `LasBridge` mangler `main.ts`-binding.
- `index.html` → `main.ts` peger stadig på den deferrede 3DGS-sti. Det der faktisk virker (LiDAR) lever i `las-smoke.html`. Ingen af dem er endnu "appen".
- **Perspektiv-korrekt point size er en no-op i smoke-siden.** Dens `VIEW_PROJ` er identitet med z-remap og positionerne er forud-normaliseret, så `clip_w` er altid 1.0 og alle punkter får `base_size_px`. Formlen er korrekt og testet, men får først effekt når en rigtig perspektiv-matrix kommer ind i point-stien — altså med `main.ts`-integrationen. Ward 23's V3 kan derfor ikke verificeres før da.
- **LAZ decode er 14x langsommere end LAS-parse**, ikke ~2x som Ward 25's spec antog: 5M punkter tager 2,7s mod 193ms (native release, syntetisk luftbåren scan). Årsagen er at Ward 21's parser er usædvanligt let (26 Mpts/s), ikke at decoderen er langsom. Under V2's ~3s-budget, men kun lige, og kun native — browser-tal mangler.
- **`LazDecoder::is_ready()`** afgør at filen er hel ved at læse chunk-tabellen, der ligger sidst. Filer hvor skriveren ikke registrerede chunk-table-offsettet (0 eller -1) kan begynde at dekomprimere for tidligt og fejle med `LazDecode` i stedet for at vente. LASzip, PDAL og laspy skriver alle offsettet. Et `las_finish()`-signal fra bridgen ville lukke hullet.
- **Test-toolchain:** Ward 018's A1-test kræver `wasm-pack` på PATH. Uden den fejler den med `ENOENT` — det er et miljøkrav, ikke en kodefejl. Rust-target `wasm32-unknown-unknown` skal også være installeret.

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
| LAZ-decode via `laz-rs` frem for manuel port eller JS `laz-perf` | `laz 0.13` med `default-features = false` bygger rent til wasm32-unknown-unknown (kun byteorder + num-traits, ingen WASI, ingen rayon). Holder decoderen i Rust — single source of truth — for +44 KB gzip | 25 |
| Buffer hele den komprimerede fil frem for byte-granulær streaming | LAZ' chunk-table-offset er absolut, og `LasZipDecompressor` seeker til den ved konstruktion; laz-rs har ingen rollback ved EOF midt i et punkt. Alternativerne var chunk-checkpoints (umuligt med opak decoder-state) eller gen-decode fra filstart (O(n²)). LAZ fylder 10-20 % af LAS, så prisen er lav | 25 |
| Test-fixtures komprimeret med LASzip C++ (via laspy), ikke laz-rs | Komprimering med referenceimplementationen og dekomprimering med laz-rs gør T2 til ægte kryds-validering frem for en round-trip gennem ét bibliotek | 25 |

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
- **Gør LiDAR-stien til appen**: `main.ts` skal default til `RENDER_MODE="points"` med drop → OPFS → LAS/LAZ → GPU, og splat-koden bag flaget. Samtidig skal `memory-pressure.ts`' 236B/element-estimat rettes, ellers afviser den præcis de store filer vi vil kunne åbne.
- **Visual verification mangler menneske**: Ward 25's V1/V2 (drop en ægte USGS/Open Topography LAZ; mål 5M i browseren) og Ward 23's V1-V3 (20M punkter, 30+ FPS under rotation, zoom).
- **Mulig LAZ-optimering, bevidst ikke taget**: `laz-rs` kan dekomprimere selektivt og springe GPS-tid over (8 bytes/punkt i PDRF 1/3), som vi alligevel kasserer. Det ville bryde Ward 25's T2 (byte-identisk sammenligning) og kontrakten om rå LAS-records — kræver derfor en egen beslutning.

### Resolved tech debt
- ✅ Ward 24: `compilationInfo()` → `getCompilationInfo()` på 4 moduler
- ✅ Ward 21: LAZ silently-strip bug — nu eksplicit `LazCompressed` error variant
- ✅ Ward 22: Wasm-memory growth-fælde i smoke-page (positions detachet ved heap-grow) — fixed med eksplicit copy ud af views
- ✅ Ward 25: LAZ-workaroundet (pip `laspy` til at konvertere til LAS først) er væk — `.laz` åbnes direkte
- ✅ Ward 25: smoke-sidens `LazCompressed`-afvisning fra Ward 21 er fjernet
- ✅ Ward 23: `VIEW_PROJ` var hardkodet i WGSL-strengen; nu eksporteret som `VIEW_PROJ_MATRIX` og shader-literalen genereres derfra
- ✅ Ward 23: `point-size.ts` hævdede at matche shaderen men gangede med `density_factor`, hvilket shaderen ikke gør
- 🟡 `wdd complete` regenererer PROGRESS.md uden at kende `deferred`-status — kræver manuel patch efter hver complete
