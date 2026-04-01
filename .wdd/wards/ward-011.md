---
ward: 11
revision: null
name: "Export Engine"
epic: "roundtrip"
status: "complete"
dependencies: [10]
layer: "rust"
estimated_tests: 7
created: "2026-03-31"
completed: "2026-04-01"
---
# Ward 011: Export Engine

## Scope
Gendan rensede data til industristandard .ply format. Iterer over ECS, filtrer deleted splats fra, og skriv en clean PLY fil via OPFS til brugerens download.

## Inputs
- Ward 10: ECS World med Deleted tags, Command system

## Outputs
- PLY binary writer (Rust)
- OPFS file writer for eksport
- Download trigger (JS)
- Export progress feedback

## Specification
1. **PLY Writer (Rust):**
   - Iterer over ECS entities
   - Filtrer entities med `Deleted` tag fra
   - Skriv PLY ASCII header med korrekt element count
   - Skriv binær data-sektion

2. **OPFS Export:**
   - Opret ny fil i OPFS
   - Stream bytes fra Rust til OPFS via sync access handle
   - Chunk-baseret skrivning

3. **Download Trigger (JS):**
   - Læs den færdige fil fra OPFS
   - Opret File objekt og trigger download
   - Ryd op i OPFS temp fil efter download

4. **Progress:**
   - Callback til JS med progress (0-100%)
   - UI viser export progress bar

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | export_header_correct | PLY header har korrekt element count (uden deleted) |
| 2 | export_excludes_deleted | Deleted splats er ikke i eksporteret fil |
| 3 | export_includes_all_active | Alle aktive splats er i eksporteret fil |
| 4 | export_binary_matches_input | Round-trip: import → export matcher original |
| 5 | export_to_opfs_chunked | Eksport streames i chunks til OPFS |
| 6 | export_download_triggers | JS modtager download signal |
| 7 | export_progress_callback | Progress callback fyrer korrekt |

## Must NOT
- Bygge filen som base64-kodet data-URI (crasher ved GB-størrelser)
- Hold hele eksportfilen i Rust hukommelsen
- Ændre original-filen i OPFS

## Must DO
- Iterer over ECS, filtrer Deleted-tagget fra
- Skriv binær byte-stream for aktive splats til ny .ply fil i OPFS
- Udløs JS-kald for bruger-download
- Chunk-baseret streaming eksport

## Verification
- Alle 7 tests er grønne
- Round-trip test: import → delete → export → re-import → korrekt antal
- Eksport af 5M splats < 2000ms
- Eksporteret fil kan åbnes i reference PLY viewer
