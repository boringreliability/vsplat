---
ward: 2
revision: null
name: "The OPFS Pipeline"
epic: "native-web-foundation"
status: "planned"
dependencies: [1]
layer: "typescript"
estimated_tests: 6
created: "2026-03-31"
completed: null
---
# Ward 002: The OPFS Pipeline

## Scope
JS overdrager en fil til OPFS, og Rust kan læse den synkront. Dette er den kritiske data-pipeline der gør det muligt at arbejde med gigabyte-store filer uden at sprænge browser-hukommelsen.

## Inputs
- Ward 1: Feature detection (OPFS check), Wasm Worker bridge

## Outputs
- Drag-and-drop file receiver (JS)
- OPFS file writer (JS Worker)
- Rust OPFS reader via FileSystemSyncAccessHandle
- File metadata message protocol

## Specification
1. **File Reception (JS Main Thread):**
   - Drag-and-drop zone der accepterer `.ply` filer
   - Validér filtype og størrelse
   - Overfør File-objekt til Worker via postMessage (transferable)

2. **OPFS Writer (JS Worker):**
   - Modtag File-objekt i Worker
   - Åbn OPFS root via `navigator.storage.getDirectory()`
   - Stream filen ned i OPFS via chunks (undgå at holde hele filen i RAM)
   - Send filnavn/sti til Rust når skrivning er komplet

3. **Rust OPFS Reader:**
   - Modtag filnavn fra JS
   - Anmod om `FileSystemSyncAccessHandle` via JS interop
   - Verificér at handle er valid og læsbar
   - Expose read API: `read_bytes(offset, length) -> &[u8]`

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | file_drop_accepts_ply | Drag-drop zone accepterer .ply filer |
| 2 | file_drop_rejects_non_ply | Drag-drop zone afviser ikke-.ply filer |
| 3 | opfs_write_small_file | En lille fil skrives korrekt til OPFS |
| 4 | opfs_write_large_file_chunked | En stor fil streames i chunks uden OOM |
| 5 | rust_read_from_opfs | Rust kan læse bytes fra OPFS via sync handle |
| 6 | rust_read_offset_length | Rust kan læse vilkårlige byte-ranges |

## Must NOT
- Indlæs .ply indholdet i en JS ArrayBuffer
- Hold hele filen i hukommelsen under overførsel til OPFS
- Bruge async file handles i Worker (vi skal bruge synkrone for Rust)

## Must DO
- JS modtager File via drag-n-drop og spoler den ned i OPFS
- JS sender filnavn til Rust
- Rust anmoder om FileSystemSyncAccessHandle
- Stream filen i chunks (f.eks. 4MB ad gangen)

## Verification
- Alle 6 tests er grønne
- En 500MB test-fil kan overføres til OPFS uden browser-crash
- Rust kan læse vilkårlige byte-ranges fra den gemte fil
