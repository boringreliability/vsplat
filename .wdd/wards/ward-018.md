---
ward: 18
revision: 1
name: "First Light"
epic: "production-hardening"
status: "complete"
dependencies: [5, 7, 8, 14, 15, 17]
layer: "typescript+rust+wasm"
estimated_tests: 4
created: "2026-04-04"
completed: "2026-04-05"
---
# Ward 018: First Light

## Problem Statement

After 17 wards of infrastructure — PLY parsing, ECS, GPU sort, SH shaders, Worker bridge, FFI, error handling — there is no way to see if any of it works together. Every test uses mocks. No test has ever:

- Instantiated a real Wasm module
- Transferred real PLY data through the Worker bridge
- Uploaded real buffers to a real GPU
- Rendered a single splat to a real canvas
- Moved a camera and seen the scene respond

Ward 18 is "First Light" — the first frame. A minimal application that proves the entire pipeline works end-to-end: file → Rust parser → Worker bridge → GPU upload → splat shader → canvas → orbit camera.

This is NOT a full editor UI. It is the simplest possible demonstration that the engine works. One HTML file, one entry point, drag-and-drop a PLY file, see splats.

## Scope

Build a minimal runnable application (`src/app/main.ts` + `index.html`) that:
1. Checks browser capabilities (Ward 17)
2. Initializes WebGPU device and canvas
3. Builds the Wasm module and starts the Worker bridge (Ward 15)
4. Accepts a PLY file via drag-and-drop
5. Loads the PLY through the Worker → Rust parser pipeline
6. Transfers parsed buffers back to main thread
7. Uploads all buffers to GPU (positions, rotations, scales, opacities, SH)
8. Runs the render pipeline (Ward 7's splat shader + Ward 12's global sort)
9. Attaches orbit camera controls (Ward 8)
10. Renders continuously via requestAnimationFrame

Plus: Vite dev server configuration for correct headers (COOP/COEP for SharedArrayBuffer, Wasm MIME type).

## Inputs

- Ward 5: `GpuSplatBuffer`, `createGpuSplatBuffer`, `uploadSplatBuffer`
- Ward 7: Splat shader (vertex + fragment), render pipeline setup
- Ward 8: Orbit camera controller
- Ward 12: Global GPU radix sort
- Ward 14: `GpuSHBuffer`, `GpuOpacityBuffer`, upload functions
- Ward 15: `createWorkerBridge`, `loadPly`, `getBuffers`, FFI exports, `wasm-pack build`
- Ward 17: `checkCapabilities`, `VsplatError`, `checkSceneMemory`

## Outputs

### Application Entry Point (`src/app/main.ts`)
```typescript
async function main() {
  // 1. Capability gate
  const caps = checkCapabilities();
  if (caps.error) { showError(caps.error); return; }

  // 2. WebGPU init
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const context = canvas.getContext("webgpu");

  // 3. Worker bridge
  const bridge = await createWorkerBridge("/pkg/vsplat_core.js", { ... });

  // 4. Drag-and-drop handler
  canvas.addEventListener("drop", async (e) => {
    const file = e.dataTransfer.files[0];
    const arrayBuffer = await file.arrayBuffer();

    // 5. Memory check
    // (estimate from file size, conservative)

    // 6. Load through Worker
    const { splatCount } = await bridge.loadPly(arrayBuffer);

    // 7. Get buffers
    const buffers = await bridge.getBuffers();

    // 8. Upload to GPU
    // ... create GPU buffers, writeBuffer from Float32Arrays

    // 9. Build render pipeline
    // ... shader modules, bind groups, sort pipeline
  });

  // 10. Render loop
  function frame() {
    // sort splats by camera depth
    // render splats
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

### HTML Shell (`index.html`)
Minimal HTML: canvas element, drop zone overlay, error message area. No framework, no build-time HTML generation. Just a `<canvas>` and a `<script type="module">`.

### Vite Configuration (`vite.config.ts`)
```typescript
export default defineConfig({
  plugins: [{
    name: "coop-coep-headers",
    configureServer(server) {
      server.middlewares.use((_, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        next();
      });
    },
  }],
  // ... Wasm file handling, worker config
});
```

### Wasm Build Integration
`wasm-pack build crates/vsplat-core --target web --out-dir ../../pkg` must succeed and produce:
- `pkg/vsplat_core.js` — wasm-bindgen JS glue
- `pkg/vsplat_core_bg.wasm` — compiled Wasm binary
- `pkg/vsplat_core.d.ts` — TypeScript declarations

### Worker Script (`src/worker/wasm-worker.ts`)
Real Worker that imports from `pkg/vsplat_core.js`, handles init/load/query-buffers messages. This is the production version of what Ward 15's tests mocked.

## Non-Outputs

- Does NOT implement a full editor UI (toolbar, panels, property inspector)
- Does NOT implement selection, deletion, or editing tools
- Does NOT implement export from the UI
- Does NOT implement undo/redo UI
- Does NOT implement file browser or recent files
- Does NOT implement responsive layout or mobile support
- Does NOT implement loading spinner or progress bar (console.log is fine)
- Does NOT need automated browser tests (visual verification is the gate)

## Specification

### 1. Capability Gate at Startup

First thing `main()` does is call `checkCapabilities()`. If `error` is non-null, display the error message in a visible DOM element (not just console). If there are warnings, log them to console.

### 2. WebGPU Initialization

Request adapter → request device → configure canvas context with `bgra8unorm` format. Handle failure at each step with `VsplatError`.

Device must request the `timestamp-query` feature if available (for future performance profiling) but must NOT fail if it's unavailable.

### 3. Wasm Build and Worker Bootstrap

`npm run build:wasm` must succeed. The `pkg/` directory must be served by Vite. The Worker script imports the wasm-bindgen glue and handles the message protocol from Ward 15.

The init handshake: main sends `{ type: "init", wasmUrl }` → Worker calls `await init(wasmUrl)` → Worker sends `{ type: "ready" }`.

### 4. Drag-and-Drop PLY Loading

Canvas element accepts drag-and-drop. On drop:
1. Read file as `ArrayBuffer`
2. Estimate splat count: `Math.floor(file.size / 236)` (236 bytes = conservative full-SH3 PLY stride). Call `checkSceneMemory(estimatedCount, 48)` with worst-case shDim. If over threshold → show error, don't attempt load.
3. Call `bridge.loadPly(arrayBuffer)` — transfers buffer to Worker
4. Call `bridge.getBuffers()` — receives Float32Arrays for all buffers
5. Create/update GPU buffers with the received data

### 5. GPU Buffer Upload

Create GPU buffers for: positions, rotations, scales, opacities, SH coefficients. All use `GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`. Upload via `device.queue.writeBuffer()`.

Also create: sort key buffer, sort index buffers (double-buffered), sort histogram/scan buffers, camera uniform buffer, sort params buffer.

### 6. Render Pipeline

Build the render pipeline from Ward 7's shader. Bind groups connect all buffers. The pipeline:

1. **Sort pass:** Ward 12's global radix sort — compute camera-space depth keys, sort indices by depth
2. **Render pass:** Ward 7's splat shader — vertex shader positions quads, fragment shader evaluates SH and applies Gaussian falloff

**Development staging:** During bring-up, rendering with identity-order indices (no sort) is acceptable to verify that the shader, buffer upload, and render loop work. This produces visible but incorrectly-ordered splats. Ward 18 is NOT complete until Ward 12 sort is integrated — but the sort should be the last piece added, not the first thing debugged. Get pixels on screen first, then fix the order.

### 7. Camera

Ward 8's orbit camera controller attached to the canvas. Mouse drag rotates, scroll zooms. Camera uniform buffer updated each frame with view-projection matrix.

### 8. Render Loop

`requestAnimationFrame` loop:
1. Update camera from input
2. Write camera uniforms to GPU
3. Encode sort compute pass (8 radix passes)
4. Encode render pass (draw instanced quads)
5. Submit command buffer

### 9. Error Display

Any `VsplatError` caught during init, load, or render is displayed in a visible DOM element with the error's `message` field. The canvas shows the last good frame (or stays blank if no scene loaded).

### 10. Deployment Configuration

Vite dev server must set COOP/COEP headers for `crossOriginIsolated` to be true. Document the headers needed for production deployment in a `DEPLOYMENT.md` file.

## Tests

Ward 18 tests are split between automated sanity checks and manual visual verification.

### Automated Tests (Vitest)

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `wasm_pack_build_succeeds` | `wasm-pack build` exits with code 0 and produces `pkg/vsplat_core.js` + `pkg/vsplat_core_bg.wasm` |
| A2 | `vite_config_has_coop_coep` | Vite config includes COOP/COEP header middleware |
| A3 | `main_entry_exports` | `src/app/main.ts` exports a `main()` function |
| A4 | `deployment_doc_exists` | `DEPLOYMENT.md` exists in project root and mentions COOP, COEP, and `application/wasm` |

### Manual Visual Verification (First Light Checklist)

The following must be verified by a human in a real browser. Screenshot or confirmation required for Ward completion.

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Open `http://localhost:5173` | Canvas visible, no errors in console (except warnings) |
| V2 | Capability gate | No error banner. Console shows "vsplat ready" or similar |
| V3 | Drop a PLY file onto canvas | Splats appear on screen within a few seconds |
| V4 | Orbit camera (mouse drag) | Scene rotates smoothly around center |
| V5 | Scroll to zoom | Camera moves closer/further |
| V6 | Drop a second PLY file | First scene replaced, new scene renders |
| V7 | Drop an invalid file | Error message displayed, app doesn't crash |
| V8 | Fragment shader correctness | Splats look like Gaussian blobs, not squares or artifacts. View-dependent color changes are visible when orbiting (SH evaluation working) |

### Deferred (NOT Ward 18)

- Performance benchmarking (fps counter, frame timing)
- Large file stress test (>1M splats)
- Mobile/touch input
- Multiple scenes / scene management

## Must NOT

- Build a full editor UI (this is First Light, not Final Form)
- Add framework dependencies (React, Vue, etc.) to the app shell
- Hardcode file paths or localhost URLs in production code
- Skip the capability gate
- Ignore VsplatError in error paths (must display to user)
- Fake the Wasm build (must use real `wasm-pack build` output)

## Must DO

- Run `wasm-pack build` successfully
- Create a real Worker script that loads real Wasm
- Transfer real PLY data through the real bridge
- Upload real buffers to a real GPU
- Render real splats with the real shader
- Attach real camera controls
- Display errors visually (not just console)
- Set COOP/COEP headers in Vite dev config
- Write DEPLOYMENT.md with production header requirements

## Verification

### Green Criteria

1. `wasm-pack build` succeeds (A1)
2. Vite config has COOP/COEP headers (A2)
3. `main.ts` exports `main()` (A3)
4. `DEPLOYMENT.md` exists with required content (A4)
5. All existing tests still pass (180/180, no regressions)
6. **Human verifies V1-V8 in a real browser**
7. **Splats are rendered with Ward 12 sort** (identity-order bring-up is OK during development, but completion requires sorted rendering)

### The Real Test

Ward 18 is complete when a human opens a browser, drops a PLY file onto the canvas, sees Gaussian splats rendered on screen, and can orbit the camera around the scene. Everything else is infrastructure. This is the moment the project becomes real.

## Relationship to Other Wards

### All Previous Wards (upstream, consumed)
Ward 18 is the integration point for every Ward 1-17. It's the first time all the pieces run together outside of mocked test environments. Failures here may reveal issues in any upstream Ward.

### Future Wards (downstream)
Once First Light works, the project can build toward:
- Selection tools (Ward 9's lasso + Ward 10's commands, wired to UI)
- Export UI (Ward 11's export engine, triggered from a button)
- Edit mode (inline property editing)
- Performance dashboard
- SOG format support
- Publishing / sharing