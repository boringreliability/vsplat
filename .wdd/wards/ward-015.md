---
ward: 15
revision: 2
name: "Production Worker Runtime"
epic: "production-hardening"
status: "complete"
dependencies: [1, 4, 5, 13, 14]
layer: "rust+typescript"
estimated_tests: 12
created: "2026-04-02"
completed: "2026-04-04"
---
# Ward 015: Production Worker Runtime

## Problem Statement

The project's foundational principle is "Rust owns data, JS owns pixels." After 14 wards, this is still a documentation claim, not a runtime reality.

**Rust side:** `vsplat-core` compiles to `cdylib` but exports zero functions. There are no `#[wasm_bindgen]` annotations, no FFI boundary, no way for TypeScript to call into Rust or read Rust memory.

**TypeScript side:** `createWorker()` in `bridge.ts` is a hard throw:

```typescript
function createWorker(wasmUrl: string | URL): Worker {
  throw new Error(`Failed to initialize Wasm worker from ${wasmUrl}`);
}
```

All Ward 1-14 tests use mocks, inline data, or test-injected workers. No test has ever instantiated the Rust Wasm module.

**The gap:** There is no Wasm binary, no Worker bootstrap, no message protocol, no memory bridge, no lifecycle management. The two halves of the architecture have never communicated.

Ward 15 closes this gap with a minimal but production-grade Worker runtime: real Wasm compilation, real Worker instantiation, typed message protocol, memory exposure for GPU upload, and clean lifecycle management.

## Scope

Implement the Rust→Wasm→Worker→TypeScript bridge. This includes wasm-bindgen FFI exports on the Rust side, a real Worker that loads and instantiates the Wasm module, a typed message protocol for main thread ↔ worker communication, memory view exposure for GPU buffer upload, and Worker lifecycle management (init, error, terminate).

This Ward produces the minimum viable bridge — enough to load a PLY file and expose its parsed data to the GPU upload pipeline. It does NOT implement the full application orchestration layer (that's UI scope).

## Inputs

- Ward 1: `bridge.ts` — message protocol types, `WorkerBridge` interface, `_testWorker` injection pattern
- Ward 1: `feature-flags.ts` — runtime capability detection
- Ward 3: `PlyParser` — Rust PLY parsing (already production-ready)
- Ward 4: `World` — Rust ECS with flat buffers (Ward 14 refactored)
- Ward 5: `WasmMemoryView` — pointer+length→Float32Array pattern
- Ward 13: `GenerationMap` — validation cache, API designed for Rust-backed transition
- Ward 14: `World.opacities`, `World.sh_coefficients` — flat buffers for GPU upload

## Outputs

### Rust FFI (`crates/vsplat-core/src/ffi.rs`)
- `#[wasm_bindgen]` exported functions:
  - `init()` → creates World, returns scene handle
  - `load_ply(data: &[u8])` → parses PLY, populates World, returns loaded splat count
  - `get_positions_ptr()` / `get_positions_len()` → pointer+length for position buffer
  - `get_sh_ptr()` / `get_sh_len()` → pointer+length for SH buffer
  - `get_opacities_ptr()` / `get_opacities_len()` → pointer+length for opacity buffer
  - `get_rotations_ptr()` / `get_rotations_len()` → pointer+length for rotation buffer
  - `get_scales_ptr()` / `get_scales_len()` → pointer+length for scale buffer
  - `get_sh_dim()` → SH dimension for the loaded scene
  - `get_splat_count()` → total number of splats in world

### Rust World changes (`crates/vsplat-core/src/ecs/world.rs`)

**Critical prerequisite:** Ward 14 flattened opacity and SH coefficients to `Vec<f32>` on World, but position/rotation/scale data still lives in `ComponentStore<Transform>`. For FFI pointer exposure, ALL render-relevant data must be flat.

Ward 15 adds flat GPU-ready buffers to World:

```rust
pub struct World {
    // ... existing fields ...
    // Ward 14 flat buffers:
    pub opacities: Vec<f32>,
    pub sh_coefficients: Vec<f32>,
    pub sh_dim: usize,
    // Ward 15 flat buffers (GPU-ready, parallel to ComponentStore<Transform>):
    pub flat_positions: Vec<f32>,   // [x0,y0,z0, x1,y1,z1, ...]
    pub flat_rotations: Vec<f32>,   // [w0,x0,y0,z0, w1,x1,y1,z1, ...]
    pub flat_scales: Vec<f32>,      // [sx0,sy0,sz0, sx1,sy1,sz1, ...]
}
```

`batch_spawn_splats` populates these with `extend_from_slice` from `SplatData`, same pattern as Ward 14's opacity/SH. The `ComponentStore<Transform>` is retained for ECS queries — the flat buffers are a parallel GPU-ready copy, not a replacement.

**Why keep both?** `ComponentStore<Transform>` supports swap-and-pop deletion and entity-indexed queries. The flat buffers are contiguous `Vec<f32>` for direct pointer exposure via FFI. The flat buffers are write-once at load time and read-only thereafter (edits update ComponentStore, then a dirty flag triggers a flat buffer rebuild). This is the same "source of truth + GPU cache" pattern that exists implicitly in Ward 5.

### Worker script (`src/worker/wasm-worker.ts`)
- Real Worker that loads Wasm module via `wasm-bindgen` generated JS glue
- Handles init, load, and memory-query messages
- Error reporting with structured error messages

### Updated bridge (`src/worker/bridge.ts`)
- Real `createWorker()` implementation (replaces the hard throw)
- Init handshake: Worker sends `ready` after Wasm instantiation
- Timeout on init (configurable, default 10s)
- `loadPly(data: ArrayBuffer)` → transfers PLY bytes to Worker, receives loaded splat count
- `getBuffers()` → sends `query-buffers`, receives transferred ArrayBuffers, wraps as Float32Arrays
- Terminate with cleanup guarantee (calls `worker.terminate()`, rejects pending promises)

### Build integration
- `wasm-bindgen` added to Cargo.toml dependencies
- `wasm-pack build` produces `pkg/` with `.wasm` + JS glue
- Package.json `build:wasm` script works end-to-end

## Non-Outputs

- Does NOT implement drag-and-drop UI (application layer scope)
- Does NOT implement render loop integration (that's orchestration scope)
- Does NOT add browser integration tests for full pipeline (Ward 17 scope)
- Does NOT implement SharedArrayBuffer zero-copy path (optimization scope)
- Does NOT modify any WGSL shaders

## Specification

### 1. Rust FFI Layer

Add `src/ffi.rs` to `vsplat-core` with `#[wasm_bindgen]` exports:

```rust
use wasm_bindgen::prelude::*;

static mut WORLD: Option<World> = None;

#[wasm_bindgen]
pub fn init() {
    unsafe { WORLD = Some(World::new()); }
}

#[wasm_bindgen]
pub fn load_ply(data: &[u8]) -> Result<u32, JsValue> {
    let world = unsafe { WORLD.as_mut().ok_or("Not initialized")? };
    let header = parse_header(data).map_err(|e| JsValue::from_str(&e))?;
    let binary = &data[header.data_offset..];
    let parser = PlyParser::new(header);
    let splats = parser.parse_all(binary).map_err(|e| JsValue::from_str(&e))?;
    let loaded_count = splats.count as u32;
    world.batch_spawn_splats(&splats);
    Ok(loaded_count)
}

#[wasm_bindgen]
pub fn get_positions_ptr() -> *const f32 { /* ... */ }
#[wasm_bindgen]
pub fn get_positions_len() -> u32 { /* ... */ }
// ... same pattern for sh, opacities, rotations, scales
```

**Why `static mut`?** A deliberate tradeoff for Ward 15. The Worker is single-threaded (guaranteed by the Web platform). There is exactly one World per Worker. `static mut` is the simplest approach. The `unsafe` block is localized to FFI boundary functions and does not propagate into Rust library code. A cleaner alternative (`thread_local!` with `RefCell<Option<World>>`) adds borrow-checking overhead per access; it may be preferred in a later ward but is not required for correctness here.

**`load_ply` return value:** Returns the number of splats loaded in THIS call, not the total scene count. Use `get_splat_count()` for the total. This avoids semantic ambiguity if multiple PLY files are loaded into the same scene.

**Memory exposure pattern:** Rust FFI functions return raw pointers and lengths into the World's flat `Vec<f32>` buffers. The Worker creates `Float32Array` views on `wasm.memory.buffer` at these offsets, copies them into transferable `ArrayBuffer`s, and sends them to Main. Main never touches Wasm memory directly.

**Copy path at load time:** `wasm-bindgen` copies the `&[u8]` input from JS heap into Wasm linear memory. This is standard wasm-bindgen behavior and unavoidable. The PLY `ArrayBuffer` is transferred (zero-copy) from Main to Worker, then copied once more into Wasm memory for Rust parsing. Total load-path copies: transfer (0) + FFI input copy (1) = 1 copy.

### 2. Worker Script and Memory Transfer

**Critical architecture note:** The Wasm instance lives in the Worker. Main thread does NOT have direct access to `wasm.memory.buffer`. Data must be transferred from Worker to Main.

**Transfer strategy for Ward 15:**

The Worker creates `Float32Array` views on `wasm.memory.buffer` using the pointer/length from FFI functions. It then copies these into new `ArrayBuffer`s and transfers them to Main via `postMessage` with transferable list. Main receives the `ArrayBuffer`s and creates `Float32Array` views for GPU upload.

This involves one copy per buffer (Wasm memory → transferable ArrayBuffer). The transfer itself is zero-copy (ownership moves from Worker to Main). GPU upload via `writeBuffer` is one more copy. Total: 2 copies per buffer per load, which is acceptable — this happens once at scene load, not per frame.

**Future optimization (not Ward 15 scope):** If `crossOriginIsolated` is true (Ward 1 feature flag), `SharedArrayBuffer` could eliminate the Worker→Main copy entirely. Both threads would read from the same backing memory. This requires COOP/COEP headers and is deferred to optimization scope.

```typescript
// src/worker/wasm-worker.ts
import init, { load_ply, get_positions_ptr, get_positions_len, /* ... */ } from "../../pkg/vsplat_core.js";
import { memory } from "../../pkg/vsplat_core_bg.wasm";

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  try {
    switch (event.data.type) {
      case "init":
        await init(event.data.wasmUrl);
        self.postMessage({ type: "ready" });
        break;

      case "load": {
        const count = load_ply(new Uint8Array(event.data.plyData));
        self.postMessage({ type: "loaded", splatCount: count });
        break;
      }

      case "query-buffers": {
        // Create views on Wasm memory, copy to transferable ArrayBuffers
        const wasmMem = new Float32Array(memory.buffer);

        const posPtr = get_positions_ptr() / 4; // byte offset → f32 index
        const posLen = get_positions_len();
        const positions = wasmMem.slice(posPtr, posPtr + posLen).buffer;

        const shPtr = get_sh_ptr() / 4;
        const shLen = get_sh_len();
        const sh = wasmMem.slice(shPtr, shPtr + shLen).buffer;

        const opPtr = get_opacities_ptr() / 4;
        const opLen = get_opacities_len();
        const opacities = wasmMem.slice(opPtr, opPtr + opLen).buffer;

        const rotPtr = get_rotations_ptr() / 4;
        const rotLen = get_rotations_len();
        const rotations = wasmMem.slice(rotPtr, rotPtr + rotLen).buffer;

        const scPtr = get_scales_ptr() / 4;
        const scLen = get_scales_len();
        const scales = wasmMem.slice(scPtr, scPtr + scLen).buffer;

        // Transfer ownership (zero-copy move from Worker to Main)
        self.postMessage(
          { type: "buffers", positions, sh, opacities, rotations, scales,
            shDim: get_sh_dim(), splatCount: get_splat_count() },
          [positions, sh, opacities, rotations, scales],
        );
        break;
      }

      case "ping":
        self.postMessage({ type: "pong" });
        break;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
```

### 3. Bridge Protocol

Messages are typed with discriminated unions. The protocol is intentionally FIFO (Ward 1 decision) — one message in, one response out, sequential.

```typescript
type MainToWorker =
  | { type: "init"; wasmUrl: string }
  | { type: "load"; plyData: ArrayBuffer }
  | { type: "query-buffers" }
  | { type: "ping" }
  | { type: "terminate" };

type WorkerToMain =
  | { type: "ready" }
  | { type: "loaded"; splatCount: number }
  | { type: "buffers"; positions: ArrayBuffer; sh: ArrayBuffer; opacities: ArrayBuffer;
      rotations: ArrayBuffer; scales: ArrayBuffer; shDim: number; splatCount: number }
  | { type: "pong" }
  | { type: "error"; message: string };
```

### 4. Bridge Lifecycle

```
Main thread                              Worker
    │                                        │
    ├─── new Worker("wasm-worker.js") ──────►│
    ├─── { type: "init", wasmUrl } ─────────►│
    │                                        ├── await init(wasmUrl)
    │◄──── { type: "ready" } ────────────────┤
    │                                        │
    ├─── { type: "load", plyData } ─────────►│  (ArrayBuffer transferred)
    │                                        ├── load_ply(data)
    │◄──── { type: "loaded", count } ────────┤
    │                                        │
    ├─── { type: "query-buffers" } ─────────►│
    │                                        ├── slice Wasm memory → ArrayBuffers
    │◄──── { type: "buffers", ... } ─────────┤  (ArrayBuffers transferred)
    │                                        │
    │  [Main wraps ArrayBuffers as           │
    │   Float32Array, uploads to GPU         │
    │   via writeBuffer]                     │
    │                                        │
    ├─── terminate() from bridge ────────────╳
```

### 5. Init Timeout

`createWorkerBridge` must implement a configurable timeout on the init handshake (default 10 seconds). If the Worker does not send `{ type: "ready" }` within the timeout, the bridge rejects with a descriptive error including the Wasm URL and elapsed time.

### 6. Buffer Freshness

Because buffers are transferred as ArrayBuffer copies from Worker to Main, there is no stale-view problem. Each `query-buffers` call produces a fresh snapshot of the current Wasm memory state. Main never holds a direct reference to Wasm memory.

If the scene is re-loaded or mutated, Main must call `getBuffers()` again to get updated data. The bridge does NOT automatically push updates — Main pulls when needed.

### 7. GenerationMap Transition (Ward 13 → Ward 15)

Ward 13's `GenerationMap` was designed with an API surface that survives this transition. In Ward 15, `GenerationMap`'s backing `Uint32Array` can optionally be pointed at a view of Rust's `EntityManager.generations` memory. However, this is NOT required for Ward 15 — the independent TypeScript `GenerationMap` remains functional. The transition to Rust-backed generations is deferred until the EntityManager exposes its generation array via FFI, which may happen in Ward 15 or a later ward.

## Tests

Tests are in `tests/ward-015/`. All tests run in Node with mocked Worker and Wasm module — real browser instantiation is Ward 17 scope.

### Category A: Rust FFI Exports

These are Rust-side tests verifying FFI function behavior. They run via `cargo test`, not Vitest.

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `ffi_init_creates_world` | `init()` succeeds. Subsequent `get_splat_count()` returns 0. |
| A2 | `ffi_load_ply_populates_world` | `load_ply(valid_bytes)` returns splat count. `get_positions_len()` = count * 3. `get_sh_len()` = count * sh_dim. `get_opacities_len()` = count. |
| A3 | `ffi_load_ply_invalid_returns_error` | `load_ply(garbage_bytes)` returns Err, not panic. World remains usable after error. |
| A4 | `ffi_memory_pointers_valid` | `get_positions_ptr()` is non-null after load. Float values at pointer match expected data. |

### Category B: TypeScript Bridge & Protocol

These are Vitest tests with mocked Worker (same `_testWorker` injection pattern from Ward 1).

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `bridge_init_handshake` | `createWorkerBridge(url)` sends `init` message, waits for `ready` response, resolves with bridge object. `bridge.ready` is true. |
| B2 | `bridge_init_timeout` | If Worker does not respond within timeout, bridge rejects with descriptive error including URL and elapsed time. |
| B3 | `bridge_load_ply` | `bridge.loadPly(arrayBuffer)` sends `load` message with transferable, receives `loaded` with splatCount. |
| B4 | `bridge_get_buffers` | `bridge.getBuffers()` sends `query-buffers`, receives transferred ArrayBuffers, returns object with `positions: Float32Array`, `sh: Float32Array`, `opacities: Float32Array`, `rotations: Float32Array`, `scales: Float32Array`, `shDim: number`, `splatCount: number`. |
| B5 | `bridge_terminate_cleanup` | After `terminate()`, `bridge.ready` is false. Subsequent calls reject. Worker.terminate() was called. |
| B6 | `bridge_error_propagation` | Worker sends `{ type: "error", message }`. Bridge rejects pending promise with the error message. |
| B7 | `bridge_load_after_terminate_rejects` | `loadPly()` after `terminate()` rejects immediately without sending a message. |
| B8 | `bridge_ping_pong_still_works` | Ward 1's ping/pong contract still holds with the updated bridge. |

## Must NOT

- Leave `createWorker()` as a hard throw
- Use `eval`, `new Function`, or dynamic code generation to load Wasm
- Hold PLY file content in main thread memory after transfer to Worker
- Assume Wasm memory views remain valid after `load_ply` (memory may grow)
- Use SharedArrayBuffer without checking `crossOriginIsolated` (Ward 1 feature flag)
- Add `unsafe` blocks outside of the FFI boundary functions
- Break Ward 1's existing ping/pong tests

## Must DO

- Add `wasm-bindgen` to Cargo.toml and annotate FFI functions
- Add `flat_positions`, `flat_rotations`, `flat_scales` as `Vec<f32>` to World, populated by `batch_spawn_splats` via `extend_from_slice`
- Implement real Worker instantiation in `createWorker()`
- Implement init handshake with configurable timeout
- Expose Rust flat buffer pointers/lengths via `#[wasm_bindgen]` functions
- Worker copies Wasm memory views into transferable ArrayBuffers and sends to Main
- Transfer PLY `ArrayBuffer` to Worker (not copy)
- Handle Worker errors with structured error messages
- Clean up Worker on terminate via `worker.terminate()` (no zombie workers)
- Maintain Ward 1's `_testWorker` injection for backward-compatible testing
- `load_ply` returns loaded count, `get_splat_count` returns total

## Verification

### Green Criteria

1. All 12 tests pass (4 Rust + 8 TypeScript)
2. `wasm-bindgen` is in Cargo.toml dependencies
3. `src/ffi.rs` exports at least: `init`, `load_ply`, `get_positions_ptr/len`, `get_sh_ptr/len`, `get_opacities_ptr/len`, `get_rotations_ptr/len`, `get_scales_ptr/len`, `get_sh_dim`, `get_splat_count`
4. `World` has `flat_positions`, `flat_rotations`, `flat_scales` as `Vec<f32>` populated by `batch_spawn_splats`
5. `createWorker()` no longer throws — it creates a real Worker (or mock via `_testWorker`)
6. Init handshake with timeout is implemented
7. `bridge.loadPly()` transfers ArrayBuffer to Worker, returns loaded count
8. `bridge.getBuffers()` returns Float32Array-wrapped transferred ArrayBuffers
9. Ward 1's ping/pong tests still pass
10. `wasm-pack build` succeeds (Rust compiles to Wasm)

### Deferred Verification

- Real Wasm instantiation in browser (Ward 17)
- End-to-end PLY load → GPU upload → render (Ward 17)
- SharedArrayBuffer zero-copy path (optimization scope)
- GenerationMap backed by Rust memory (can happen in this Ward or later)

## Relationship to Other Wards

### Ward 1 (upstream, updated)
`bridge.ts` is updated with real `createWorker()`. `_testWorker` injection pattern preserved. Existing Ward 1 tests must remain green.

### Ward 3/4 (upstream, unmodified)
`PlyParser` and `World` are called from FFI functions but not modified. Their test suites remain green.

### Ward 5 (upstream, pattern reused)
`WasmMemoryView` pattern (pointer + length → Float32Array view) is how the bridge exposes Rust data. The actual `createWasmMemoryView` function from Ward 5 can be reused directly.

### Ward 13 (upstream, transition prepared)
`GenerationMap` API was designed for Rust-backed transition. Ward 15 can optionally point it at Rust's generation array, but this is not required.

### Ward 14 (upstream, consumed)
The flat `Vec<f32>` buffers on `World` are what the FFI pointer functions expose. This is the direct payoff of Ward 14's refactoring.

### Ward 17 (downstream)
Browser integration tests that actually instantiate Wasm, load a real PLY file, and verify the full pipeline. Ward 15's bridge is the foundation for those tests.