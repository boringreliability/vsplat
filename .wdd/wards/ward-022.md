---
ward: 22
revision: null
name: "Intensity Color-Ramp Mapping"
epic: "point-cloud-pivot"
status: "planned"
dependencies: [20, 21]
layer: "typescript+wgsl"
estimated_tests: 6
created: "2026-05-26"
completed: null
---
# Ward 022: Intensity Color-Ramp Mapping

## Scope
Erstat Ward 20's konstante hvide fragment-output med en farve-mapping styret af LAS `intensity` (eller `classification`, eller `rgb` hvis tilstede). Color ramps udsendes som 1D textures uploaded via `device.queue.writeTexture`. UI tilbyder et dropdown med fire foruddefinerede ramps (Viridis, Inferno, Grayscale, Elevation), samt en "RGB direct"-tilstand for PDRF 2/3/7-filer. Min/max normalization udregnes per fil ved load (Ward 21 eksporterer histogrambounds), så ramps adapter sig til scenens dynamic range.

## Inputs
- Ward 20: point shader-pipeline (fragment stage skal udvides)
- Ward 21: `intensity`, `rgb`, `classification` SoA-buffers + histogram-bounds (`intensity_min`, `intensity_max`)

## Outputs
### `src/webgpu/color-ramps.ts`
- Fire ramps som `Uint8Array` (256 RGBA): Viridis, Inferno, Grayscale, Elevation
- `uploadColorRamp(device, ramp): GPUTexture` — 1D 256×1 RGBA8Unorm texture

### `src/webgpu/point-shader.ts` (udvidet)
- Ny vertex-output: `@location(1) intensity_norm: f32`
- Fragment: `let color = textureSample(ramp_tex, ramp_sampler, intensity_norm); return color;`
- Bind group udvidet med ramp texture + sampler + uniform `{ min, max, mode }`

### `src/app/main.ts` (udvidet)
- Dropdown for ramp-valg (4 ramps + "RGB direct")
- Uniform buffer opdateres ved skift
- `min/max` initialiseres fra Ward 21's histogram-bounds

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
   - 32-element konstant palette (LAS ASPRS-klassifikationer: Ground=2 brun, Vegetation=3-5 grøn osv.)
5. **RGB-mode validering:**
   - Hvis bruger vælger "RGB direct" men buffer mangler: UI viser warning, fald tilbage til intensity
6. **Ward Boundary Contract Test:**
   - GPU-output for `intensity_norm = 0.5` på Viridis-ramp skal matche CPU-reference (Matplotlib Viridis index 128) inden for ±1/255

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `viridis_ramp_has_256_entries_rgba8` | `ramp.length === 1024` |
| T2 | `intensity_normalization_clamps_outliers` | Input < min → 0.0; input > max → 1.0 |
| T3 | `color_mode_uniform_layout_correct` | `mode` uniform offset/alignment matcher shader binding |
| T4 | `classification_palette_has_32_entries` | Palette-textur er 32×1 RGBA8Unorm |
| T5 | `rgb_direct_mode_uses_per_point_rgb_buffer` | Vertex shader læser `rgb`-buffer når `mode === 2` |
| T6 | `viridis_at_half_matches_cpu_reference` | Cross-stage contract test: GPU sample ved 0.5 ≈ Matplotlib Viridis[128] |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | LAS PDRF 1 + Viridis ramp | Lav intensity = mørkeblå, høj = gul. Glatte gradienter, ingen banding |
| V2 | LAS PDRF 3 + "RGB direct" | Naturlige farver (terræn ser farvet ud som virkeligheden) |
| V3 | Skift ramp via dropdown | Øjeblikkelig farve-respons uden flicker eller frame drop |
| V4 | Classification-mode på fil med klasser | Ground=brun, Vegetation=grøn — visuelt konsistent med ASPRS-konvention |

## Must NOT
- Generere ramps runtime (alle 4 ramps skal være statisk data)
- Implementere brugerdefinerede ramps (potentiel Ward 25)
- Cachere normalisering pr. punkt i en separat buffer (kør i shader)
- Brække Ward 20's hvide-pixel-rendering når `mode` ikke er sat (default skal være intensity)

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
