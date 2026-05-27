---
ward: 21
revision: null
name: "LAS/LAZ Stream Ingestion"
epic: "point-cloud-pivot"
status: "planned"
dependencies: [2, 3, 15, 16, 20]
layer: "rust"
estimated_tests: 9
created: "2026-05-26"
completed: null
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
- Scale + offset anvendes i parser: `x_f32 = (x_i32 as f32) * scale.x + offset.x`

### `crates/vsplat-core/src/las/laz.rs` (valgfri)
- Trait `Decompressor` med to implementationer: `LasPassThrough` og `LazDecoder` (kun hvis laz-rs/laszip-rs viser sig levedygtig på Wasm)
- LAZ flag detekteres fra header `point_data_format` high bit
- Hvis LAZ-decoder ikke kan bygges til Wasm i Red-fasen: ward leverer kun LAS, og LAZ flyttes til future Ward 24

### `crates/vsplat-core/src/ffi.rs` (udvidet)
- `pub fn parse_las_chunk(ptr, len) -> ParseResult` — wasm-bindgen export
- `pub fn las_buffers() -> LasBuffers` — eksponerer ptr+len for hver SoA-buffer

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
   - SoA-layout udsendt fra Ward 21 skal være præcis det layout som Ward 20's point-shader binder

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `las_header_magic_recognized` | Header med `LASF` magic accepteres; andre rejected |
| T2 | `las_header_version_1_4_parsed` | Version 1.4 header: alle 375 bytes læst korrekt |
| T3 | `pdrf_0_yields_xyz_intensity_classification` | PDRF 0 fil producerer netop disse 3 buffers |
| T4 | `pdrf_3_yields_xyz_intensity_rgb_classification` | PDRF 3 fil producerer alle 4 buffers |
| T5 | `scale_and_offset_applied_correctly` | Kendt i32-input × scale + offset matcher forventet f32 |
| T6 | `streaming_parser_handles_partial_chunks` | Buffer splittet midt i et point record samles korrekt |
| T7 | `unsupported_pdrf_returns_error` | PDRF 99 returnerer `LasError::UnsupportedFormat` |
| T8 | `large_offset_avoids_f32_precision_loss` | UTM-koordinater (offset ~500000) bevarer mm-præcision |
| T9 | `worker_emits_progress_events` | TS-side: progress callbacks fyrer per chunk |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Indlæs en lille åben LAS-fil (~100K points) | Punkter renderes i korrekt geografisk konfiguration |
| V2 | Indlæs en LAS-fil med RGB (PDRF 3) | Buffers er allokeret (Ward 22 håndterer faktisk farve) |
| V3 | Indlæs 5M-point LAS | Ingen out-of-memory, ingen frame drops under load |

## Must NOT
- Implementere intensity-color mapping (det er Ward 22)
- Implementere LAZ hvis laz-rs ikke kan bygges til `wasm32-unknown-unknown` i Red-fasen — skub til future ward i stedet for at hacke
- Allokere mellemkopi i JS — Wasm-buffer → GPU buffer skal være zero-copy
- Brække PLY-parser (regression-gate på Ward 3 tests)

## Must DO
- Genbruge Ward 16's chunked-reader API
- Eksponere SoA-buffers via samme FFI-mønster som Ward 15
- Dokumentere PDRF-support matrix i `.wdd/CONTEXT.md`
- Tilføje LAS-test-fixtures til `tests/ward-021/fixtures/` (små filer < 100 KB)

## Verification
- T1-T9 grønne i `cargo test` og Vitest
- V1-V3 visuelt verificeret med rigtige LAS-filer
- QA1 reviewer LAZ-beslutning (in-scope vs. skub-til-ward-24)
- Performance: 5M point LAS parses i < 3 sekunder på reference-maskine
