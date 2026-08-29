---
ward: 25
revision: null
name: "LAZ Decompression"
epic: "point-cloud-pivot"
status: "gold"
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

## Spike Result (Red-fase, 2026-08-29)

**Strategi #1 valgt: `laz` (laz-rs) v0.13.0 på `wasm32-unknown-unknown`.**

| Kriterium | Resultat |
|-----------|----------|
| Bygger til `wasm32-unknown-unknown` | ✅ `default-features = false` |
| Transitive deps | `byteorder` + `num-traits` (+ `autocfg` som build-dep) — **ingen WASI, ingen rayon** |
| Dekomprimerer LASzip-C++-output | ✅ byte-identisk med ukomprimeret reference |
| LAS 1.2 / PDRF 3 (PointWiseChunked) | ✅ 1 000 points |
| LAS 1.4 / PDRF 6 (LayeredChunked) | ✅ 1 000 points |
| Multi-chunk (120 000 pts / 3 chunks) | ✅ korrekt hen over alle chunk-grænser |

Strategi #2 (manuel port) og #3 (`laz-perf` i JS) er dermed ikke i brug.

### Svar på spec'ens åbne spørgsmål (til QA1's godkendelse)

1. **Strategi-prioritet:** Ikke relevant — `laz-rs` er både lavrisiko og hurtig nok; ingen perf-afvejning at tage stilling til.
2. **Streaming vs. full-decode:** **Full-buffer af komprimerede bytes, batch-vis decode.** Spike'en viste hvorfor: LAZ' chunk-table-offset er en *absolut* filoffset, og `LasZipDecompressor` seeker til den ved konstruktion. Decoderen kan derfor ikke fodres med et vindue af filen. Dertil har laz-rs ingen rollback hvis en decode rammer EOF midt i et punkt, så ægte byte-granulær streaming ville kræve enten chunk-checkpoints (ikke muligt med laz-rs' opake state) eller gen-decode fra filstart (O(n²)). Vi buffrer i stedet de komprimerede bytes (LAZ er 10–20 % af LAS-størrelsen) og dekomprimerer i batches, så progress kan rapporteres uden at blokere workeren. T4 låser den kontrakt.
3. **LAZ 1.4 chunk-format:** Begge understøttes fra start — det koster os intet, da `laz-rs` håndterer både fixed-size og variable-size chunks. `pdrf6_v14`-fixturen dækker LAS 1.4-stien.

### Test-fixtures

`crates/vsplat-core/tests/fixtures/` (97 KB i alt) er genereret med `generate_fixtures.py` via **laspy + LASzip C++-backend** — altså referenceimplementationen, ikke laz-rs. Komprimering med den ene og dekomprimering med den anden gør T2 til en ægte kryds-implementeringstest frem for en round-trip gennem ét bibliotek. `lazrs`-backenden er bevidst ikke installeret; generatoren asserter det.

### API-kontrakt låst af Red-testene

```rust
// crates/vsplat-core/src/las/laz.rs (ny)
pub const LAZ_BACKEND: &str = "laz-rs";
pub struct LazVlrInfo { chunk_size: u32, items_size: u64, variable_size_chunks: bool, point_data_offset: usize }
pub fn find_laz_vlr(file: &[u8], header: &LasHeader) -> Result<LazVlrInfo, LasError>;
pub trait Decompressor {
    fn push_compressed(&mut self, bytes: &[u8]);
    fn decompress_chunk(&mut self, max_points: usize) -> Result<Vec<u8>, LasError>;
    fn points_remaining(&self) -> u64;
    fn is_done(&self) -> bool;
}
pub struct LazDecoder; // impl Decompressor

// header.rs — Ward 21's parse_las_header() og LasError::LazCompressed er UÆNDREDE
pub fn parse_las_header_allow_compressed(bytes: &[u8]) -> Result<LasHeader, LasError>;
// LasHeader får: pub compressed: bool   (point_data_format maskeres med 0x3F)
// LasError får:  MissingLazVlr, LazDecode(String)

// stream_parser.rs — LasParser::parse_chunk() håndterer LAZ transparent
// las-bridge.ts — LasLoadResult/LoadedMsg får: compressed: boolean
```

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

## Gold Result (2026-08-29)

Alle 6 tests grønne. Fuld suite: **46 Rust** (41 baseline + T1-T5) og **202 TypeScript** — inklusive Ward 018's `wasm-pack`-test, som nu kan køre fordi toolchainen er installeret. Ingen regressioner.

### Implementeret

| Fil | Ændring |
|-----|---------|
| `src/las/laz.rs` (ny) | `Decompressor` trait, `LazDecoder`, `find_laz_vlr`, `LAZ_BACKEND` |
| `src/las/header.rs` | `parse_las_header_allow_compressed`, `LasHeader.compressed`, `LasError::{MissingLazVlr, LazDecode}` |
| `src/las/stream_parser.rs` | `ParseState::BufferingLaz` + `parse_chunk_laz` — samme `emit_point` som ukomprimeret input |
| `src/ffi.rs` | `las_compressed()` |
| `src/worker/las-bridge.ts` | `LasLoadResult.compressed` |
| `src/app/las-smoke.ts`, `las-smoke.html` | LAZ-afvisningen fra Ward 21 fjernet; HUD viser LAS/LAZ |
| `Cargo.toml` | `laz = { version = "0.13", default-features = false }` |

`parse_las_header` og `LasError::LazCompressed` er uændrede — Ward 21's kontrakt er intakt, verificeret af T1 og af Ward 21's egen `t1d`.

### Målinger

**Wasm-størrelse** (`wasm-pack build --target web`, release):

| | Rå | Gzip |
|---|---|---|
| Før Ward 25 | 73 KB | 31 KB |
| Med LAZ | 277 KB | 75 KB |

LAZ-decoderen koster altså **+204 KB rå / +44 KB gzip**.

**Decode + parse, 5M punkter** (native release, syntetisk luftbåren scan, sorterede flyvelinjer):

| Input | Størrelse | Tid | Rate |
|-------|-----------|-----|------|
| LAS (ukomprimeret) | 170 MB | 193 ms | 25,9 Mpts/s |
| LAZ | 34,6 MB | 2 709 ms | 1,8 Mpts/s |

Med tilfældige koordinater (worst case for LAZ' prædiktive kodning) blev det 4 029 ms / 98 MB.

**To ting QA1 bør notere:**

1. **Spec'ens "~2x langsommere end LAS" holder ikke** — vi måler **14x**. Årsagen er ikke at laz-rs er langsom, men at Ward 21's parser er ekstremt let (ren SoA-udtrækning ved 26 Mpts/s), så decoderen dominerer totalt. Det absolutte tal lander stadig under spec'ens V2-budget på ~3s for 5M — men kun lige, og **native**. Wasm er typisk 1,2-2x langsommere, så V2 i browseren er ikke afgjort af mine målinger.
2. **Mulig optimering, bevidst ikke taget:** `laz-rs` kan dekomprimere selektivt (`DecompressionSelection`) og springe felter over vi alligevel smider væk — først og fremmest GPS-tid, som er 8 bytes per punkt i PDRF 1/3. Det ville bryde T2's byte-identiske sammenligning og kontrakten om at levere rå LAS-records, så det hører til en separat beslutning.

### Kendt begrænsning

`LazDecoder::is_ready()` afgør at filen er hel ved at prøve at læse chunk-tabellen, som ligger sidst i filen. Filer hvor skriveren ikke har registreret chunk-table-offsettet (feltet står som 0 eller -1) kan derfor begynde at dekomprimere for tidligt og fejle med `LazDecode` i stedet for at vente på flere bytes. LASzip, PDAL og laspy skriver alle offsettet, så det rammer ikke normale filer — men en `las_finish()`-signal fra bridgen ville lukke hullet helt.

### Visual Verification — mangler menneske

V1 (drop en ægte USGS/Open Topography LAZ i `las-smoke.html`) og V2 (5M-punkt LAZ i browseren under ~3s) kræver GPU og rigtige filer, som containeren ikke har. Smoke-siden accepterer nu `.laz` og viser formatet i HUD'en, så begge kan køres direkte.
