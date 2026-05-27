---
ward: 25
revision: null
name: "LAZ Decompression"
epic: "point-cloud-pivot"
status: "planned"
dependencies: [21]
priority: "medium"
layer: "rust"
estimated_tests: 6
created: "2026-05-27"
completed: null
---
# Ward 025: LAZ Decompression

## Scope
Tilføj LAZ-decode (komprimeret LAS) til ingestions-pipelinen. Ward 21 detekterer LAZ-flag og returnerer `LasError::LazCompressed`; dette ward leverer en faktisk decoder så LAZ-filer parses transparent. LAZ er **de facto LiDAR-format** (open data fra USGS, Open Topography, NOAA distribueres ofte kun som .laz pga. 80-95% kompressionsforhold). Uden LAZ-support er Ward 21's faktiske brugsværdi stærkt begrænset.

## Problem Statement
Ward 21's parser kan kun læse ukomprimerede LAS-filer. Realiteten:
- USGS LiDAR open data: kun .laz
- Open Topography: kun .laz
- NOAA Digital Coast: kun .laz
- Velodyne-eksport: typisk .laz

Ward 21's smoke-test bekræftede dette: alle brugerens test-filer var .laz, ingen .las. Brugbarheden er tæt på 0% uden LAZ.

## Spike (1 ud af 3 udfald)

LAZ-decode kræver en arithmetic coder + LAS-specifikt kontekst-model. Tre realistiske strategier (rangordnet efter risiko):

1. **`laz-rs` crate på wasm32-unknown-unknown** (lavrisiko først):
   - Hvis det linker rent uden WASI: implementér via `LazDecoder` trait — afsluttet i ~2 dage.
   - Det er sandsynligvis funktionsdygtigt; `laz-rs` annoncerer Wasm-support i README.

2. **Port `laz-rs`'s decoder-logik manuelt** (middel risiko):
   - Hvis crate ikke kan bygges: port relevant decoder-kode (~3-5K LOC) til vores crate.
   - 1-2 uger; high precision LAZ håndtering kræver omhyggelig test mod kanon-fixtures.

3. **JS-side `laz-perf` via WebAssembly** (sidste resort):
   - `laz-perf` er den oprindelige C++ LAZ-decoder kompileret til Wasm via Emscripten.
   - Dekomprimer i JS, send rå LAS-bytes til vores eksisterende Rust-parser.
   - Mister single-source-of-truth (decoder lever udenfor vores crate), men virker garanteret.

Red-fasen starter med at evaluere strategi #1.

## Inputs
- Ward 21: `LasParser`, `LasError::LazCompressed`, ASPRS LAS header-parser
- Ward 15: wasm-bindgen + FFI-mønster
- Ward 16: chunked streaming I/O

## Outputs
### `crates/vsplat-core/src/las/laz.rs` (ny)
- `Decompressor` trait med metoder `decompress_chunk(input: &[u8]) -> Vec<u8>` (eller streaming-ækvivalent)
- `LazDecoder` impl baseret på valgt strategi
- LAZ VLR-parsing (Variable Length Record med chunk-table)

### `crates/vsplat-core/src/las/stream_parser.rs` (udvidet)
- `LasParser` accepterer enten LAS- eller LAZ-input gennem en abstrakt input-stream
- LAZ-detektion via header high-bit → automatisk wrap af input i decoder

### `Cargo.toml` (udvidet)
- Tilføj `laz` dependency med wasm-features hvis strategi #1 virker

### Tests
- T1: `laz_decoder_recognizes_compressed_input`
- T2: `laz_decoded_output_matches_uncompressed_reference` (kanon LAS vs samme fil i LAZ)
- T3: `laz_vlr_chunk_table_parsed`
- T4: `streaming_laz_chunks_partial_decode`
- T5: `laz_fallback_strategy_chosen` (dokumenterer hvilken impl-strategi vi tog)
- T6 (TS): `worker_bridge_handles_laz_seamlessly`

### Visual Verification
- V1: Drop en LAZ-fil i `las-smoke.html` → renderes uden konvertering
- V2: Performance: 5M-point LAZ decode + parse skal være under ~3s (ca. 2x langsommere end LAS ifølge laz-rs benchmarks er acceptabelt)

## Must NOT
- Tilføje WASI-runtime dependencies (skal bygge til `wasm32-unknown-unknown`)
- Decode LAZ i JS hvis Rust-strategi virker (single source of truth)
- Brække Ward 21's tests
- Ændre `LasError::LazCompressed` variant — den signaliseres af Ward 21 og er nu en kontrakt

## Must DO
- Vurder de tre strategier i Red-fasen, dokumentér valg i T5
- Levere transparent LAS+LAZ-support på samme bridge
- Verificere mod faktiske USGS/Open Topography LAZ-filer (V1)

## Open Questions for QA1
1. **Strategi-prioritet:** Skal vi tage `laz-rs` selv hvis det er 50% langsommere end manuel port? Mit forslag: ja — vedligehold kommer først, perf andet.
2. **Streaming vs. full-decode:** Skal LAZ-decoder streame chunks ligesom Ward 21's parser, eller dekomprimere fuldt før parse-stage? Streaming er mere komplekst men matcher Ward 16's I/O-model.
3. **LAZ 1.4-specifik chunk-format:** LAZ-spec'en blev udvidet i v1.4 med variable chunks. Skal vi støtte begge formats fra start eller kun det mest udbredte v1.0?
