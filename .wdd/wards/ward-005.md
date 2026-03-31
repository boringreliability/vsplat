---
ward: 5
revision: null
name: "WebGPU Low-Copy Bridge & Basic Render"
epic: "ecs-webgpu-engine"
status: "planned"
dependencies: [4]
layer: "typescript"
estimated_tests: 7
created: "2026-03-31"
completed: null
---
# Ward 005: WebGPU Low-Copy Bridge & Basic Render

## Scope
Få splat-positioner fra Rust RAM til GPU vRAM med minimal kopiering, og tegn dem som farvede quads. Første visuelle milestone — splats på skærmen.

## Inputs
- Ward 4: ECS World med Transform og SplatMaterial komponenter

## Outputs
- Wasm memory → WebGPU buffer bridge
- WebGPU device/pipeline setup
- Basic vertex/fragment shader (farvede quads)
- Render loop med requestAnimationFrame

## Specification
1. **Low-Copy Bridge:**
   - Expose Wasm linear memory som `Float32Array` view i JS
   - Rust returnerer pointer + length til position data i ECS
   - JS mapper dette direkte til en `GPUBuffer` via `writeBuffer`
   - Ingen JSON serialization, ingen kopiering ud over den ene writeBuffer

2. **WebGPU Setup:**
   - Request adapter + device med required features
   - Opret canvas context med `webgpu` format
   - Configure swap chain

3. **Basic Render Pipeline:**
   - Vertex shader: billboard quad per splat (4 vertices, instanced)
   - Fragment shader: simpel farve fra DC (f_dc_0, f_dc_1, f_dc_2) koefficienter
   - Alpha blending enabled
   - Hardcoded kamera (perspektiv, fast position) — rigtig kamera i Ward 8

4. **Render Loop:**
   - `requestAnimationFrame` loop
   - Opdatér GPU buffer når ECS data ændres (dirty flag)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | wasm_memory_view_valid | Float32Array view af Wasm memory er læsbar |
| 2 | gpu_buffer_created | WebGPU buffer oprettes med korrekt størrelse |
| 3 | gpu_buffer_data_matches | Data i GPU buffer matcher Rust ECS data |
| 4 | render_pipeline_compiles | Shader kompilerer uden fejl |
| 5 | render_loop_starts | requestAnimationFrame loop kører |
| 6 | canvas_not_blank | Canvas har ikke-sorte pixels efter render |
| 7 | dirty_flag_prevents_unnecessary_upload | Buffer uploades kun ved ændringer |

## Must NOT
- Send data som JSON
- Brug Canvas 2D
- Kopier data til et mellemliggende JS array før GPU upload

## Must DO
- Expose Wasm-memory som et Float32Array view i JS
- Map direkte til en WebGPU Vertex/Storage buffer
- Skriv en basal WebGPU vertex/fragment shader der tegner splats som farvede quads
- Implementér dirty flag for buffer updates

## Verification
- Alle 7 tests er grønne
- Splats vises som farvede punkter/quads på skærmen
- Ingen synlig frame drop ved 1M splats
