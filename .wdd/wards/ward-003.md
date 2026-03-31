---
ward: 3
revision: null
name: "PLY Streaming Parser"
epic: "native-web-foundation"
status: "planned"
dependencies: [2]
layer: "rust"
estimated_tests: 8
created: "2026-03-31"
completed: null
---
# Ward 003: PLY Streaming Parser (Zero-Copy Target)

## Scope
Parse .ply filer direkte fra OPFS ind i ECS-kompatible data-strukturer. Fokus er på zero-copy: data skal mappes direkte fra disk til Rust structs uden mellemliggende kopier.

## Inputs
- Ward 2: OPFS read API (`read_bytes(offset, length)`)

## Outputs
- PLY header parser (ASCII)
- Binary chunk streamer
- Parsed splat data i SoA (Struct of Arrays) layout klar til ECS
- Splat count og property metadata

## Specification
1. **ASCII Header Parser:**
   - Læs header byte-for-byte indtil `end_header`
   - Parse element count (antal splats)
   - Parse property definitions (x, y, z, nx, ny, nz, f_dc_0..2, opacity, scale_0..2, rot_0..3, f_rest_0..N)
   - Beregn byte offset og stride for binær sektion

2. **Binary Chunk Streamer:**
   - Allokér kapacitet i Rust baseret på splat count
   - Stream binære chunks (1MB ad gangen) fra OPFS
   - Map bytes direkte til Rust structs via `bytemuck` eller pointer casting
   - Progress callback til JS (for UI progress bar)

3. **SoA Data Layout:**
   - Separate arrays for positions (f32x3), rotations (f32x4), scales (f32x3), SH coefficients, opacity
   - Layout optimeret til GPU upload (Ward 5)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | parse_ply_header_basic | Korrekt parsing af standard PLY header |
| 2 | parse_ply_header_with_sh | Korrekt parsing af header med SH koefficienter |
| 3 | parse_ply_header_invalid | Graceful error ved ugyldig header |
| 4 | stream_binary_single_chunk | Korrekt parsing af lille PLY (< 1MB) |
| 5 | stream_binary_multi_chunk | Korrekt parsing af PLY der kræver multiple chunks |
| 6 | verify_soa_layout | Data er korrekt fordelt i SoA arrays |
| 7 | verify_zero_copy_path | Ingen unødvendige Vec-allokeringer under parsing |
| 8 | progress_callback_fires | JS modtager progress updates under streaming |

## Must NOT
- Opret mellemliggende Rust Vec kopier for hver splat, hvis memory kan castes direkte
- Læs hele filen ind i ét stort buffer
- Antag en fast property-rækkefølge i PLY-filen

## Must DO
- Læs ASCII headeren først
- Udregn antal splats og alloker kapacitet i Rust
- Stream binære chunks (1MB ad gangen) og map direkte til Rust structs
- Håndtér varierende PLY property layouts

## Verification
- Alle 8 tests er grønne
- 5M splat PLY fil parses på < 2000ms
- Peak memory usage under parsing er < 1.5x final data size
