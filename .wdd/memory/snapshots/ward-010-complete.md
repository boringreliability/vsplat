# Context — vsplat

## Last Updated
Ward 9 complete — 2026-04-01

## Current State
Ward 1-9 complete. 90 tests (74 TS + 16 Rust). Full selection pipeline: frustum culling (Gribb/Hartmann), zero-alloc lasso with precomputed BBox, strict boundary contract (all edges/vertices = outside). 2 wards remaining.

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
- Ward 10: Command System & Editor Actions — undo/redo, delete, transform commands
