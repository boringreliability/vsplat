---
ward: 6
revision: null
name: "Radix Sort Compute Shader"
epic: "ecs-webgpu-engine"
status: "planned"
dependencies: [5]
layer: "wgsl"
estimated_tests: 6
created: "2026-03-31"
completed: null
---
# Ward 006: Radix Sort Compute Shader

## Scope
Alpha-blending kræver back-to-front sortering. GPU-accelereret Radix Sort via WebGPU Compute Shaders der sorterer splat-indekser baseret på dybde hvert frame.

## Inputs
- Ward 5: WebGPU device, splat position buffer, render pipeline

## Outputs
- Compute shader der beregner splat-dybder
- Radix Sort compute pipeline (multi-pass)
- Sorteret index buffer til rendering
- Integration med render loop

## Specification
1. **Depth Calculation (Compute Pass 1):**
   - Input: position buffer + view matrix
   - Output: depth buffer (f32 per splat) + index buffer (u32 per splat)
   - Beregn `depth = dot(viewDir, position - cameraPos)`

2. **Radix Sort (Compute Pass 2-N):**
   - 32-bit float depth → reinterpret som sortable uint32 (flip sign bit)
   - 8-pass radix sort (4 bits per pass) med prefix sum
   - Double-buffering for in-place sort
   - Workgroup size optimeret til GPU (256 threads)

3. **Integration:**
   - Sorteret index buffer bruges som draw indirect / index buffer
   - Render pipeline opdateres til at bruge sorterede indekser
   - Sort kører hvert frame (kamera kan bevæge sig)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | depth_calculation_correct | Dybder beregnes korrekt fra kameraposition |
| 2 | radix_sort_small_array | Korrekt sortering af 1K elementer |
| 3 | radix_sort_large_array | Korrekt sortering af 1M+ elementer |
| 4 | sort_stability | Stabil sortering (lige dybder bevarer rækkefølge) |
| 5 | sort_performance_budget | Sort af 5M splats < 4ms |
| 6 | sorted_render_correct_order | Render bruger sorterede indekser (back-to-front) |

## Must NOT
- Sorter på CPU'en i Rust
- Bruge comparison-based sort (O(n log n)) — Radix Sort er O(n)
- Allokere nye buffere per frame (genbrug eksisterende)

## Must DO
- Skriv en WebGPU Compute Shader med Radix Sort
- Tag splat-dybden (afstand til kamera) som nøgle
- Udfør sort på indekserne for hvert frame
- Hold sort-tiden under 4ms for 5M splats

## Verification
- Alle 6 tests er grønne
- Sort af 5M splats konsistent < 4ms på moderne GPU
- Visuelt: ingen alpha-blending artefakter
