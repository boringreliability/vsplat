---
ward: 21
revision: null
name: "LAS/LAZ Stream Ingestion"
epic: "point-cloud-pivot"
status: "complete"
dependencies: [2, 3, 15, 16, 20]
layer: "rust+typescript"
estimated_tests: 9
created: "2026-05-26"
completed: "2026-05-27"
---
# Ward 021: LAS/LAZ Stream Ingestion

## Scope
Indfør LAS-format (ASPRS Public Header + Point Data Record) som primær input til motoren. Implementér en streaming-parser i Rust efter samme mønster som Ward 3's PLY-parser: header parses synkront, point records streames i chunks fra OPFS via Ward 16's `True Streaming I/O` pipeline. SoA-buffers (`xyz: Float32Array`, `intensity: Uint16Array`, `rgb?: Uint8Array`, `classification: Uint8Array`) bliver fyldt direkte i Wasm-hukommelse og eksponeret zero-copy til JS via Ward 15's FFI-mønster. LAZ-support introduceres som valgfri dekompressions-trin (laz-rs eller laszip-rs vurderes i Red-fasen).

## Inputs
- Ward 2: OPFS-pipeline (sync access handles, chunked reads)
- Ward 3: PLY streaming-parser (reference for stream-state-machine)
- Ward 15: wasm-bindgen FFI-mønster og Wasm-hukommelses-eksport
- Ward 16: True Streaming I/O (chunked reader-API)
- Ward 20: Point shader-pipeline (forbruger af de udsendte buffers)

## Outputs
### `crates/vsplat-core/src/las/header.rs`
- Parser for ASPRS Public Header Block (versioner 1.2, 1.3, 1.4)
- Felter: `point_data_format`, `point_data_record_length`, `number_of_point_records`, `scale_factors`, `offsets`, `min/max xyz`, `version_major/minor`
- Strict-mode: ukendte felter logges, men afbryder ikke parsing

### `crates/vsplat-core/src/las/stream_parser.rs`
- Tilstandsmaskine: `Header → Vlr → PointRecords → Done`
- Support for PDRF (Point Data Record Format) 0, 1, 2, 3, 6, 7 (de mest udbredte)
- Per-chunk output: appends til SoA-buffers via `bytemuck::cast_slice` hvor muligt
- Scale + offset anvendes via **f64-mellemmål** for at undgå præcisionstab på UTM-koordinater:
  ```rust
  x_f32 = (x_i32 as f64 * scale_x + offset_x) as f32
  ```
  (`scale_x` og `offset_x` parses som `f64` direkte fra LAS-headeren.)

### `crates/vsplat-core/src/las/laz.rs` (valgfri)
- Trait `Decompressor` med to implementationer: `LasPassThrough` og `LazDecoder` (kun hvis laz-rs/laszip-rs viser sig levedygtig på Wasm)
- LAZ flag detekteres fra header `point_data_format` high bit
- Hvis LAZ-decoder ikke kan bygges til Wasm i Red-fasen: ward leverer kun LAS, og LAZ flyttes til future Ward 25 (LAZ Decompression). Ward 24 er allerede taget af WebGPU API Migration.

### `crates/vsplat-core/src/ffi.rs` (udvidet)
Følger samme ptr/len-mønster som Ward 15 (wasm-bindgen kan ikke eksportere structs med slice-felter direkte). Eksporter pr. SoA-buffer:

```rust
#[wasm_bindgen] pub fn las_parse_chunk(ptr: *const u8, len: usize) -> ParseResult;
#[wasm_bindgen] pub fn las_positions_ptr() -> *const f32;
#[wasm_bindgen] pub fn las_positions_len() -> usize;
#[wasm_bindgen] pub fn las_intensity_ptr() -> *const u16;
#[wasm_bindgen] pub fn las_intensity_len() -> usize;
#[wasm_bindgen] pub fn las_rgb_ptr() -> *const u8;       // length=0 hvis PDRF uden RGB
#[wasm_bindgen] pub fn las_rgb_len() -> usize;
#[wasm_bindgen] pub fn las_classification_ptr() -> *const u8;
#[wasm_bindgen] pub fn las_classification_len() -> usize;
```

`ParseResult` er en simpel enum/struct med `points_added: u32` og `done: bool`. Ingen aggregeret `LasBuffers`-type — Ward 15-mønstret er etableret, og wasm-bindgen håndterer det renere.

### `src/worker/las-worker.ts` (ny)
- Stream LAS-bytes fra OPFS → `parse_las_chunk` loop
- Send progress-events til main thread
- Postér færdige buffers via `postMessage` med `Transferable` (eller zero-copy via SharedArrayBuffer hvis `crossOriginIsolated`)

## Specification
1. **Format-detektion:**
   - Magic bytes `LASF` i offset 0
   - Versions-felter `version_major` (offset 24), `version_minor` (offset 25)
2. **PDRF-mapping → komponenter:**
   - PDRF 0/1/6: `xyz + intensity + classification` (ingen RGB)
   - PDRF 2/3/7: `xyz + intensity + RGB + classification`
   - Andre PDRF: `Result::Err` med klar fejlbesked
3. **Numerisk præcision:**
   - LAS lagrer XYZ som `i32` med globale scale+offset → konverter til `f32` ved parse
   - For meget store koordinater (UTM): subtraher header `offset` før f32-cast for at undgå f32-præcisionstab
4. **Chunked parsing:**
   - Chunk-størrelse aligned til `point_data_record_length` × 1024 (typisk 28-34 KB)
   - Parser kan suspendere mellem point records
5. **Ward Boundary Contract Test:**
   - `positions`-bufferens layout (interleaved XYZ f32) skal matche Ward 20's point-shader binding 0 (`splat_positions: array<f32>`)
   - **Ward 21 ændrer IKKE Ward 20's bind group layout.** `intensity`, `rgb`, `classification` buffers eksisterer i Wasm-memory men bindes først af Ward 22 når color-ramp introduceres. Ward 20's pipeline forbliver med kun 1 binding.

## Tests

### Rust (`cargo test`)

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `las_header_magic_recognized` | Header med `LASF` magic accepteres; andre rejected |
| T2 | `las_header_version_1_4_parsed` | Version 1.4 header: alle 375 bytes læst korrekt |
| T3 | `pdrf_0_yields_xyz_intensity_classification` | PDRF 0 fil producerer netop disse 3 buffers |
| T4 | `pdrf_3_yields_xyz_intensity_rgb_classification` | PDRF 3 fil producerer alle 4 buffers |
| T5 | `scale_and_offset_applied_correctly` | Kendt i32-input × scale + offset matcher forventet f32 |
| T6 | `streaming_parser_handles_partial_chunks` | Buffer splittet midt i et point record samles korrekt |
| T7 | `unsupported_pdrf_returns_error` | PDRF 99 returnerer `LasError::UnsupportedFormat` |
| T8 | `large_offset_avoids_f32_precision_loss` | UTM-koordinater (offset ~500000) bevarer mm-præcision (verificeret via f64-mellemmål) |

### TypeScript (Vitest, `tests/ward-021/`)

| # | Test Name | Verifies |
|---|-----------|----------|
| T9 | `worker_emits_progress_events` | Worker bridge fyrer progress-callbacks per chunk |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Indlæs en lille åben LAS-fil (~100K points) | Punkter renderes i korrekt geografisk konfiguration |
| V2 | Indlæs en LAS-fil med RGB (PDRF 3) | Buffers er allokeret (Ward 22 håndterer faktisk farve) |
| V3 | Indlæs 5M-point LAS | Ingen out-of-memory, ingen frame drops under load |

## Must NOT
- Implementere intensity-color mapping (det er Ward 22)
- Implementere LAZ hvis `laz-rs` ikke kan bygges til `wasm32-unknown-unknown` uden WASI-extensions inden for **2 timers forsøg** i Red-fasen — skub til Ward 25 (LAZ Decompression)
- Ændre Ward 20's bind group layout — `intensity`/`rgb`/`classification` bindes først af Ward 22
- Allokere mellemkopi i JS — Wasm-buffer → GPU buffer skal være zero-copy
- Brække PLY-parser (regression-gate på Ward 3 tests)
- Assert på elapsed tid i `cargo test` eller Vitest (timing-budget verificeres kun manuelt — log/print er OK)

## Must DO
- Genbruge Ward 16's chunked-reader API
- Eksponere SoA-buffers via samme FFI-mønster som Ward 15
- Dokumentere PDRF-support matrix i `.wdd/CONTEXT.md`
- Tilføje LAS-test-fixtures til `tests/ward-021/fixtures/` (små filer < 100 KB)

## Verification
- T1-T8 grønne i `cargo test`, T9 grøn i Vitest
- V1-V3 visuelt verificeret i browser med rigtige LAS-filer (kræver smoke-page eller `main.ts` integration — vurderes ved Gold)
- QA1 reviewer LAZ-beslutning (in-scope vs. skub-til-Ward 25) baseret på 2-timers integration-budget
- **V-perf (manuel, ikke automated):** 5M point LAS parses i under 3 sekunder på reference-maskine (M1/i5-12th). Måles via `performance.now()` i Worker, logges til konsol. Aldrig som assertion.
