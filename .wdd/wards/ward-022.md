---
ward: 22
revision: null
name: "Intensity Color-Ramp Mapping"
epic: "point-cloud-pivot"
status: "complete"
dependencies: [20, 21]
layer: "typescript+wgsl"
estimated_tests: 7
created: "2026-05-26"
completed: "2026-05-27"
---
# Ward 022: Intensity Color-Ramp Mapping

## Scope
Erstat Ward 20's konstante hvide fragment-output med en farve-mapping styret af LAS `intensity` (eller `classification`, eller `rgb` hvis tilstede). Color ramps udsendes som 1D textures uploaded via `device.queue.writeTexture`. UI tilbyder et dropdown med fire foruddefinerede ramps (Viridis, Inferno, Grayscale, Elevation), samt en "RGB direct"-tilstand for PDRF 2/3/7-filer. Min/max normalization udregnes per fil ved load (Ward 21 eksporterer histogrambounds), så ramps adapter sig til scenens dynamic range.

## Inputs
- Ward 20: point shader-pipeline (fragment stage skal udvides, bind group expands)
- Ward 21: `intensity`, `rgb`, `classification` SoA-buffers via FFI (`las_intensity_ptr/len`, `las_rgb_ptr/len`, `las_classification_ptr/len`). Ward 21 leverer IKKE histogram-bounds — det udregnes i TS i Ward 22.

## Outputs
### `src/webgpu/color-ramps.ts`
- Fire ramps som `Uint8Array` (256 × 4 = 1024 bytes RGBA): Viridis, Inferno, Grayscale, Elevation
- 32-element classification-palette som separat `Uint8Array` (128 bytes RGBA)
- `uploadColorRamp(device, ramp): GPUTexture` — 1D 256×1 RGBA8Unorm texture

### `src/webgpu/point-pipeline.ts` — `compileColoredPointPipeline()` (NY funktion)
**Ward 20's `compilePointPipeline()` røres IKKE.** Ward 22 opretter en parallel funktion:
- `compileColoredPointPipeline(device, format): Promise<ColoredPointPipeline>`
- Returnerer separat `ColoredPointPipeline` interface med egen `bindGroupLayout` (7 bindings: positions storage VERTEX, intensity storage VERTEX, rgb storage VERTEX, classification storage VERTEX, ramp_texture FRAGMENT, ramp_sampler FRAGMENT, uniform_buffer VERTEX+FRAGMENT)
- WGSL shader er separat fra Ward 20's — ingen #if-branching

Det bevarer Ward 20's regression-test T6 (`vertex_shader_uses_xyz_only` på den oprindelige pipeline). Las-smoke vælger eksplicit hvilken pipeline der bruges.

### `src/app/las-smoke.ts` + `las-smoke.html` (udvidet — IKKE `main.ts`)
Note: `main.ts` er Ward 18's 3DGS app shell — den røres ikke. Ward 22's UI lives i LAS smoke-pagen indtil en dedikeret LAS app shell etableres (potentiel future ward eller del af Ward 23).

- Dropdown for ramp-valg (4 ramps + "RGB direct" + "Classification" + "Elevation")
- Uniform buffer opdateres ved skift
- `min/max` initialiseres fra histogram udregnet i Ward 22 (Ward 21 leverer kun rå intensity-buffer — histogrammet udregnes i TS efter parse, før upload)

### Color-modes (uniform `mode: u32`):
- `0` = intensity ramp (default)
- `1` = classification (diskret palette med 32 farver, indekseret med `classification % 32`)
- `2` = RGB direct (kun gyldig for PDRF 2/3/7)
- `3` = elevation (Z-værdi som ramp-input)

## Specification
1. **Normalization:**
   - `intensity_norm = clamp((intensity - min) / (max - min), 0.0, 1.0)`
   - Beregnes i vertex shader fra uniform `{min, max}` — ingen pre-computation i Rust
2. **Ramps som data:**
   - Hardcoded `Uint8Array(256 * 4)` — ingen JSON, ingen runtime-generering
   - Kilder dokumenteres i kommentar (Matplotlib/colormap-paper-reference)
3. **Sampler:**
   - `magFilter: "linear"`, `minFilter: "linear"`, `addressModeU: "clamp-to-edge"`
4. **Classification-mode:**
   - 32-element konstant palette (dækker ASPRS-klasser 0-31; brugerreserverede klasser 32-255 wrappes via `classification % 32`)
   - Konventioner: Ground=2 brun, Low Veg=3 lysegrøn, Med Veg=4 grøn, High Veg=5 mørkegrøn, Building=6 grå, Water=9 blå
6. **RGB pakning til GPU storage:**
   - Ward 21 leverer `rgb`-buffer som 3 bytes per point (u8 high-byte downsampling fra LAS u16).
   - WebGPU storage buffers kræver 4-byte aligned access. 3-byte stride er ikke direkte tilgængelig som `array<u8>` i WGSL storage.
   - **Beslutning:** Ward 22 re-pakker Ward 21's 3-byte rgb-buffer til en 4-byte RGBA-buffer (A=255) i TS før GPU upload. Ward 21's buffer-format er uændret. Shader læser `rgb_buffer: array<u32>` og udpakker per-channel med bit-shifts: `let packed = rgb_buffer[index]; let r = f32(packed & 0xFFu) / 255.0; ...`.
   - Memory cost: 20M points × 4B = 80MB (vs. 60MB hvis 3-byte). 25% overhead er acceptabelt mod kompleksitet i shader.
5. **RGB-mode validering:**
   - Hvis bruger vælger "RGB direct" men buffer mangler: UI viser warning, fald tilbage til intensity
6. **Ward Boundary Contract Test:**
   - GPU-output for `intensity_norm = 0.5` på Viridis-ramp skal matche CPU-reference (Matplotlib Viridis index 128) inden for ±1/255

## Tests (Vitest, CPU-side — GPU-output verificeres kun manuelt via V-gates)

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `viridis_ramp_has_256_entries_rgba8` | `VIRIDIS_RAMP.length === 1024` (256 × 4 bytes) |
| T2 | `normalize_intensity_cpu_reference_clamps_outliers` | CPU-helper `normalizeIntensity(x, min, max)`: input < min → 0.0, input > max → 1.0, midpunkt → 0.5 |
| T3 | `color_mode_uniform_serializes_to_correct_byte_layout` | `ColorModeUniform.toArrayBuffer()`: min @ offset 0 (f32), max @ offset 4 (f32), mode @ offset 8 (u32). Total 16 bytes (med 4 byte padding for std140) |
| T4 | `classification_palette_has_32_entries_rgba8` | `CLASS_PALETTE.length === 128` (32 × 4 bytes) |
| T5 | `colored_pipeline_bind_group_layout_has_correct_bindings` | `ColoredPointPipeline.bindGroupLayout` har binding 0 (positions storage VERTEX), binding 1 (intensity storage VERTEX), binding 2 (rgb storage VERTEX), binding 3 (classification storage VERTEX), binding 4 (texture FRAGMENT), binding 5 (sampler FRAGMENT), binding 6 (uniform VERTEX+FRAGMENT) |
| T6 | `viridis_at_half_matches_matplotlib_reference` | **CPU-only contract test:** `VIRIDIS_RAMP[128*4..128*4+3]` matcher Matplotlib Viridis[128] inden for ±1/255 per kanal. Verificerer at vores hardkodede ramp ikke har drift fra reference. GPU's lineær interpolation testes IKKE i Vitest — kun visuelt via V1. |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | LAS PDRF 1 + Viridis ramp | Lav intensity = mørkeblå, høj = gul. Glatte gradienter, ingen banding. Verificerer GPU's lineær sampling fungerer (T6 dækker kun statisk ramp-data). |
| V2 | LAS PDRF 3 + "RGB direct" | Naturlige farver (terræn ser farvet ud som virkeligheden) |
| V3 | Skift ramp via dropdown | Farveændring synlig inden næste requestAnimationFrame (manuel UX-gate, ikke automated assertion) |
| V4 | Classification-mode på fil med klasser | Ground=brun, Vegetation=grøn — visuelt konsistent med ASPRS-konvention |

## Must NOT
- Generere ramps runtime (alle 4 ramps skal være statisk data)
- Implementere brugerdefinerede ramps (potentiel future ward — Ward 25 er allerede taget af LAZ Decompression)
- Cachere normalisering pr. punkt i en separat buffer (kør i shader)
- **Ændre adfærd i `compilePointPipeline()` / Ward 20's pipeline** — den forbliver white-pixel-output (regression-gate på Ward 20 T6). Ward 22's `compileColoredPointPipeline()` har `mode=0` (intensity) som default for SIN egen pipeline.

## Must DO
- Eksponere ramp-valg i UI dropdown
- Sikre at "RGB direct"-mode er disabled hvis buffer mangler
- Dokumentere klassifikations-palette i `.wdd/CONTEXT.md`
- Tilføje cross-stage contract test (T6)

## Verification
- T1-T6 grønne i Vitest
- V1-V4 visuelt verificeret i browser
- QA1 reviewer farve-paletternes tilgængelighed (kontrast for daltonister på Viridis)
- Performance: ramp-skift skal ikke koste mere end 1 frame
