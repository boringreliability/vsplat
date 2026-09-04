---
ward: 26
revision: null
name: "LiDAR Production Path"
epic: "point-cloud-pivot"
status: "complete"
dependencies: [16, 17, 21, 22, 23, 25]
priority: "high"
layer: "typescript"
estimated_tests: 10
created: "2026-08-29"
completed: "2026-09-04"
---
# Ward 026: LiDAR Production Path

## Scope
Gør LiDAR-stien til *appen*. Epic 06 har bygget hele motoren — LAS/LAZ-parser, point-pipeline, color ramps, batched draws — men den lever i `las-smoke.html`, som læser filen med `file.arrayBuffer()` i main thread. Imens peger `index.html` → `main.ts` stadig på den deferrede 3DGS-sti. Ingen af dem er produktet. Dette ward flytter LiDAR-stien ind i `main.ts` med den rigtige I/O-model: drop → OPFS → Worker → Wasm-parser → GPU, med et ægte perspektiv-kamera og Ward 23's batched draws. Undervejs lukkes to huller som Epic 06 har efterladt: `wasm-worker.ts` har ingen LAS-håndtering (bridgen sender `las-begin`/`las-chunk`/`las-end` ud i ingenting), og `memory-pressure.ts` estimerer 236 B/element for alt, hvilket afviser præcis de store LiDAR-filer motoren nu kan åbne.

## Problem Statement
Epic 06's completion criteria er ikke opfyldt, selvom alle epic'ens wards er complete:

- *"En fuld LAS/LAZ fil kan parses via OPFS og uploade data direkte til WebGPU-buffers uden mellemliggende kopier i JS"* — smoke-siden holder hele filen i en JS `ArrayBuffer`, hvilket direkte modsiger projektets egen constraint om at JS aldrig må holde filindholdet.
- *"Scenen kan visualisere over 20 millioner punkter"* — `checkSceneMemory()` afviser 20M punkter længe før GPU'en gør, fordi den regner med 3DGS-footprint.

Dertil er `LasBridge` (Ward 21) skrevet mod en worker-protokol der aldrig blev implementeret i `wasm-worker.ts`. Bridgen er testet mod en mock; der findes ingen modtager.

## Inputs
- Ward 16: chunked OPFS streaming I/O
- Ward 17: `checkCapabilities`, `checkSceneMemory`, `VsplatError`-taksonomi
- Ward 21: `LasBridge`, `las_*` FFI
- Ward 22: color ramps + `colored-point-pipeline`
- Ward 23: `BatchManager`, `planBatchDraws`, `AdaptiveDensityThrottler`
- Ward 25: transparent LAZ-decode
- Ward 8: `OrbitController`, `CameraSystem`, perspektiv-matrix

## Outputs

### `src/worker/las-worker-handler.ts` (ny)
Modtagersiden af Ward 21's protokol, skrevet som en **ren funktion** frem for direkte `self.onmessage`, så den kan testes uden en rigtig Worker:

```ts
export interface LasWasmModule { /* las_init, las_parse_chunk, las_*_ptr/len, las_compressed */ }
export function createLasWorkerHandler(
  wasm: LasWasmModule,
  post: (msg: unknown, transfer?: Transferable[]) => void,
): (msg: unknown) => void;
```

- `las-begin` → `las_init()`, nulstil tællere
- `las-chunk` → `las_parse_chunk(bytes)`, post `las-progress` per chunk
- `las-end` → post `las-loaded` med `{ pointCount, hasRgb, hasClassification, compressed }`
- `las-get-buffers` → post `las-buffers` med views over Wasm-memory
- Enhver kastet fejl → `las-error`, og **ingen** efterfølgende `las-loaded`

`wasm-worker.ts` binder handleren til `self.onmessage` ved siden af sine eksisterende PLY-beskeder.

### `src/errors/memory-pressure.ts` (udvidet)
Format-bevidst estimat i stedet for ét hardkodet tal:

```ts
export type SceneFormat = "splats" | "points";
export function estimateSceneMemory(count: number, shDim: number, format?: SceneFormat): number;
export function checkSceneMemory(count: number, shDim: number, threshold?: number, format?: SceneFormat): VsplatError | null;
```

- `"splats"` (default — Ward 17's adfærd uændret): 236 B input-stride + SoA + GPU, ×1.5
- `"points"`: LAS record (≤36 B) + SoA (12 B positions + 2 B intensity + 4 B rgba + 1 B class = 19 B) + GPU-kopi, ×1.5
- **LAZ tæller med**: de komprimerede bytes ligger i Wasm-memory under decode (Ward 25). Estimatet lægger 20 % af den ukomprimerede input-størrelse oveni når `compressed` er sat.

### `src/app/scene-format.ts` (ny)
```ts
export type SceneFormat = "ply" | "las";
export function detectSceneFormat(fileName: string, head: Uint8Array): SceneFormat | null;
```
Detektion på **magic bytes**, ikke filendelse: `LASF` → `"las"` (også for `.laz`, som Ward 25 håndterer transparent), `ply` → `"ply"`. Endelsen bruges kun som fallback i fejlbeskeden.

### `src/app/main.ts` (omskrevet)
- `RENDER_MODE` defaulter til `"points"`; splat-stien bevares bag `"splats"`
- Drop → `detectSceneFormat` → OPFS-write i chunks → Worker streamer fra OPFS til parser → `las-loaded` → GPU-upload → batched render
- **Filen holdes aldrig i en JS `ArrayBuffer`**: `File.stream()` → OPFS chunk-write → Worker læser tilbage i chunks
- Ægte perspektiv-kamera (Ward 8) i point-stien, så `clip_w` varierer og Ward 23's point-size-formel får effekt
- Ward 23's `planBatchDraws` driver draw calls; Ward 22's ramper styrer farve

### `index.html`
Drop-tekst og titel afspejler LiDAR-stien; `.las`/`.laz`/`.ply` accepteres.

## Specification

1. **I/O-model.** `File.stream().getReader()` → skriv chunks til OPFS via Ward 16 → post `las-begin`/`las-chunk`/`las-end` fra Worker'ens OPFS-læsning. Main thread ser aldrig hele filen. For LAZ betyder det at *komprimerede* bytes streames; Ward 25's decoder buffrer dem selv i Wasm-memory.
2. **Memory gate.** Kaldes med `format: "points"` og punktantal fra headeren før upload. 20M punkter skal passere med 2 GB-tærsklen; 20M splats skal fortsat afvises.
3. **Kamera.** Point-stien bruger `CameraSystem` + `OrbitController` som splat-stien. Perspektiv-matricen skal ind i `colored-point-pipeline` som uniform — den er i dag en hardkodet konstant (`VIEW_PROJ_MATRIX`). Konstanten bevares som default, så Ward 23's tests og smoke-siden er upåvirkede.
4. **Batching.** Draw calls går gennem `planBatchDraws`; frustum-planerne kommer fra det ægte view-projection, ikke fra en rotationsmatrix.
5. **Splat-stien.** Uændret bag `RENDER_MODE="splats"`. Ward 19's arbejde forbliver regression-baseline.

## Tests

### TypeScript (Vitest, `tests/ward-026/`)

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `las_worker_handler_streams_chunks_to_parser` | `las-begin`/`las-chunk`×N/`las-end` → `las_init` én gang, `las_parse_chunk` per chunk, progress per chunk |
| T2 | `las_worker_handler_reports_load_result` | `las-loaded` bærer pointCount, hasRgb, hasClassification og `compressed` fra Wasm-modulet |
| T3 | `las_worker_handler_surfaces_parse_errors` | En kastende `las_parse_chunk` giver `las-error` og **ingen** `las-loaded` |
| T4 | `las_worker_handler_exposes_buffers` | `las-get-buffers` → `las-buffers` med korrekt længde-views over Wasm-memory |
| T5 | `memory_estimate_is_format_aware` | `"points"` giver et markant lavere estimat per element end `"splats"`; default er uændret `"splats"` |
| T6 | `memory_gate_admits_20m_points_and_still_guards_splats` | 20M points passerer 2 GB-tærsklen; 20M splats afvises fortsat med `SCENE_TOO_LARGE` |
| T7 | `scene_format_detected_from_magic_bytes` | `LASF` → `"las"` uanset endelse (`.laz` inkl.); `ply` → `"ply"`; skrald → `null` |
| T8 | `perspective_camera_makes_point_size_depth_dependent` | Med en ægte perspektiv-matrix er `clip_w` ≠ 1, så et nært punkt får større `computePointSize` end et fjernt — Ward 23's formel er ikke længere en no-op |
| T9 | `file_is_never_held_whole_in_a_js_array_buffer` | Load-stien kalder aldrig `File.arrayBuffer()`; den bruger `File.stream()` og skriver chunks til OPFS |
| T10 | `render_mode_defaults_to_points_and_splat_path_stays_reachable` | Default er `"points"`; `"splats"` vælger stadig splat-pipelinen |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Drop en `.laz` på `index.html` | Punktsky renderes med Viridis; ingen konvertering, ingen fejl |
| V2 | Drop en 20M-punkts fil | Ingen `SCENE_TOO_LARGE`; første frame < 5 s |
| V3 | Orbit + zoom | Punkter vokser når kameraet nærmer sig — perspektiv-korrekt størrelse virker (Ward 23's V3, som ikke kunne verificeres i smoke-siden) |
| V4 | `RENDER_MODE="splats"` + en `.ply` | Splat-stien renderer stadig — ingen regression |

## Must NOT
- Holde fil-indholdet i en JS `ArrayBuffer` — projektets hårde constraint
- Ændre `estimateSceneMemory`s default-adfærd for splats (Ward 17's tests skal forblive grønne uden ændringer)
- Røre `las-smoke.html` / `las-smoke.ts` — de forbliver Epic 06's reference-side
- Fjerne splat-stien eller Ward 19's kode
- Detektere format på filendelse alene

## Must DO
- Implementere modtagersiden af Ward 21's worker-protokol
- Lade `colored-point-pipeline` tage view-projection som uniform, med `VIEW_PROJ_MATRIX` som default
- Køre draw calls gennem Ward 23's `planBatchDraws`
- Opdatere `index.html` så drop-teksten matcher hvad appen faktisk kan

## Verification
`npx vitest run` grøn (inkl. alle tidligere wards), `npx tsc --noEmit` uden nye fejl, og V1-V4 kørt i browser af et menneske.

## Gold Result (2026-08-29)

Alle 10 tests grønne. Fuld suite: **215 TypeScript** (1 skipped) + **46 Rust**. `las-smoke.ts`/`las-smoke.html` er ikke rørt — Must-NOT overholdt.

### Implementeret

| Fil | Ændring |
|-----|---------|
| `src/worker/las-worker-handler.ts` (ny) | Modtagersiden af Ward 21's protokol som ren funktion |
| `src/worker/wasm-worker.ts` | `las-*`-beskeder routes til handleren; eksplicit FFI-adapter |
| `src/errors/memory-pressure.ts` | `SceneFormat`-parameter + LAZ-residens; splat-default uændret |
| `src/app/scene-format.ts` (ny) | Magic-byte-detektion |
| `src/app/scene-loader.ts` (ny) | `File.stream()` → `ChunkSink`, aldrig en samlet buffer |
| `src/app/render-mode.ts` (ny) | `DEFAULT_RENDER_MODE = "points"` |
| `src/render/normalize.ts` (ny) | UTM → render-rum i f64 før f32 |
| `src/camera/math.ts` | `multiplyMatrices` |
| `src/webgpu/colored-point-pipeline.ts` | `viewProj: "constant" \| "uniform"` |
| `src/app/main.ts` | Omskrevet til LiDAR-appen |
| `index.html` | Titel + drop-tekst |

### Beslutninger truffet under implementeringen

**Én chunk, to modtagere.** `loadSceneFile`'s `ChunkSink` gav en pænere løsning end spec'ens "Worker læser tilbage fra OPFS": hver chunk skrives til OPFS *og* sendes til workeren i samme gennemløb. Filen gennemløbes én gang, kun én chunk er resident, og OPFS-kopien ligger klar til senere genindlæsning uden nyt drop. Ward 2's `writeFileToOpfs` bruges derfor ikke — den tager en hel `File` og slicer selv, hvilket ville betyde et ekstra gennemløb.

**Point-input tælles ikke med i memory-estimatet.** For splats indgår input-filen (236 B/element), fordi PLY-stien holder den. Point-stien streamer, så der er aldrig en resident kopi — kun SoA'en (19 B) plus dens GPU-kopi, og for LAZ de komprimerede bytes decoderen holder (konservativt 20 % af 36 B/punkt). Uden den skelnen ville 20M punkter lande på 2,2 GB og blive afvist af 2 GB-tærsklen; nu lander de på 1,1 GB.

**`viewProj` blev en variant, ikke en ændring.** At gøre matricen til en uniform ville have tvunget `las-smoke.ts` til at ændre bind group — mod ward'ets egen Must-NOT. I stedet vælger `compileColoredPointPipeline` mellem en indbagt konstant (default, uændret layout) og binding 8. Kun `main.ts` beder om uniform-varianten.

### Fundet undervejs

Placeholderen i shader-strengen var først skrevet som `${VIEW_PROJ_DECL}` inde i et template literal — altså en ægte JS-interpolation, der fik hele modulet til at fejle ved import. Vitest kørte på cache og rapporterede grønt; `npx vitest run --no-cache` afslørede det. Testene siger nu 19 hvor de før sagde 12 for de samme to wards.

`npx tsc --noEmit` afslørede også at Ward 25 aldrig deklarerede `las_compressed` på `WasmModule` — rettet i Ward 23's commit. Værd at bemærke: test-suiten kunne ikke fange nogen af delene.

### Visual Verification — mangler menneske

V1-V4 kræver GPU og rigtige filer. Bemærk at V3 (zoom) nu *kan* verificeres: `main.ts` bruger et ægte perspektiv-kamera, så `clip_w` varierer med dybden og Ward 23's point-size-formel har effekt — modsat smoke-siden.
