# vsplat — Browser-Native 3D Gaussian Splatting Studio

## Identity
- **Name:** vsplat
- **One-liner:** Fotorealistisk 3D-redigering. Desktop-performance i browseren.
- **License:** MIT + Apache 2.0 (dual)
- **Fork Origin:** Bygget på principperne fra vcore (Data-scale web engine)

## Architecture Overview
Rust (Wasm) ejer al data via ECS. JS/WebGPU ejer rendering-pipelinen.
OPFS bruges til scene streaming — filer læses direkte fra disk via synkrone access handles i en Web Worker.
WebGPU Compute Shaders håndterer GPU-accelereret Radix Sort for 60 FPS alpha-blending.

```
Application Layer (React/Svelte) → UI + File drop
JS Main Thread Bridge (COOP/COEP) → WebGPU Setup + OPFS + SharedArrayBuffers
Rust Web Worker (wasm32 baseline / memory64 opt-in) → OPFS Reader + ECS World
Low-copy WebGPU Buffer Pipeline → Vertex/Storage buffers
WebGPU Pipeline → Compute Sort + SH Fragment Shading
```

## Principles
- **Rust ejer data, JS/WebGPU ejer pixels** — Hukommelsen og ECS bor i Rust
- **Hybrid Wasm Strategi** — wasm32-unknown-unknown baseline, memory64 fast path via runtime detection
- **OPFS Scene Streaming** — Filer via OPFS i Web Worker, JS er kun pass-through
- **GPU-Accelereret Sortering** — Radix Sort via WebGPU Compute Shaders
- **Zero-copy hvor muligt** — Minimér kopiering mellem Rust RAM og GPU vRAM

## Technology Stack
- **Rust/Wasm:** ECS, PLY parsing, data ownership
- **TypeScript:** UI layer, WebGPU setup, camera controls, file handling
- **WebGPU:** Rendering pipeline, compute shaders (radix sort, SH evaluation)
- **OPFS:** Scene file streaming via FileSystemSyncAccessHandle
- **React/Svelte:** Application UI layer

## Performance Budgets
| Phase | Budget | Comment |
|-------|--------|---------|
| Load (5M splats) | < 3000 ms | Fra PLY parse til første frame |
| Compute Sort (GPU) | < 4 ms | Radix Sort per frame |
| Render (GPU) | < 10 ms | Rasterization & Blending |
| Lasso Selection | < 20 ms | 2D Polygon projicering test |
| Total Frametime | < 16 ms | = 60fps målsætning |

## Non-Goals
- **IKKE et UI-framework** — React/Svelte til knapper; Rust ejer kun 3D-scenen
- **IKKE en Cloud-tjeneste** — Al processering sker lokalt. Privatliv og hastighed i fokus
- **IKKE kun en viewer** — Vi bygger et redigeringsværktøj med fuld Undo/Redo
