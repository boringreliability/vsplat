---
ward: 1
revision: null
name: "Infrastructure & Feature Detection"
epic: "native-web-foundation"
status: "complete"
dependencies: []
layer: "typescript"
estimated_tests: 6
created: "2026-03-31"
completed: "2026-03-31"
---
# Ward 001: Infrastructure & Feature Detection

## Scope
Opsætning af Wasm Worker og JS-bro med runtime feature-detection. Dette er fundamentet som alt andet bygger på — vi skal vide hvad browseren kan, før vi kan vælge den optimale code path.

## Inputs
Ingen — dette er den første Ward.

## Outputs
- Feature detection modul (memory64, WebGPU, OPFS, SharedArrayBuffer, COOP/COEP)
- Wasm Worker med ping/pong message passing
- JS Bridge der kan kommunikere med Rust Worker

## Specification
1. **Feature Detection Module (JS):**
   - Detect `WebGPU` support via `navigator.gpu`
   - Detect `OPFS` support via `navigator.storage.getDirectory()`
   - Detect `memory64` Wasm support via probe-compilation
   - Detect `SharedArrayBuffer` availability (requires COOP/COEP headers)
   - Detect `crossOriginIsolated` context
   - Returnér et samlet `FeatureFlags` objekt

2. **Wasm Worker Setup:**
   - Kompilér et minimalt Rust crate til `wasm32-unknown-unknown`
   - Instantiér Wasm-modulet i en dedicated Web Worker
   - Implementér ping/pong message protocol (JS sender "ping", Rust svarer "pong")

3. **JS Bridge:**
   - Typed message protocol mellem main thread og worker
   - Error handling for worker initialization failures

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | detect_webgpu_available | Feature detection returnerer korrekt WebGPU status |
| 2 | detect_opfs_available | Feature detection returnerer korrekt OPFS status |
| 3 | detect_memory64_support | Memory64 probe returnerer boolean |
| 4 | detect_cross_origin_isolated | COOP/COEP header check fungerer |
| 5 | worker_ping_pong | Wasm Worker svarer "pong" på "ping" |
| 6 | worker_init_error_handling | Graceful error ved manglende Wasm support |

## Must NOT
- Antag at SharedArrayBuffer er tilgængelig uden at tjekke headers (COOP/COEP)
- Hardcode feature flags — de SKAL detekteres runtime
- Bruge synchronous loading af Wasm på main thread

## Must DO
- Implementer feature-detection for memory64, WebGPU og OPFS i JS-laget
- Kompiler et simpelt ping/pong worker-setup i wasm32-unknown-unknown
- Returnér et samlet FeatureFlags objekt med alle capabilities
- Håndtér browsers der mangler features gracefully

## Verification
- Alle 6 tests er grønne
- Feature detection kører korrekt i Chrome (med WebGPU) og Firefox (uden WebGPU)
- Worker ping/pong round-trip < 10ms
