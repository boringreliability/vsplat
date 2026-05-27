---
ward: 20
revision: null
name: "The Point Cloud Shader & Pipeline Clean"
epic: "point-cloud-pivot"
status: "complete"
dependencies: [5, 18]
layer: "typescript+wgsl"
estimated_tests: 7
created: "2026-05-26"
completed: "2026-05-27"
---
# Ward 020: The Point Cloud Shader & Pipeline Clean

## Scope
Amputér den eksisterende 3DGS render-pipeline og erstat den med en minimal, GPU-billig point-pipeline. Vertex shader skal kun transformere `xyz` til clip-space og emittere en størrelse i pixels; fragment shader skal blot returnere en konstant farve (placeholder for Ward 22). Radix-sortering deaktiveres og bypass'es i render-loopet; depth-buffer aktiveres som primær synlighedsmekanisme (forarbejde til Ward 23). Dette er ward'et der beviser at hele "tunge stack" kan fjernes uden at brække den øvrige motor.

## Inputs
- Ward 5: WebGPU buffer-upload-mønstre og zero-copy bridge
- Ward 18: App shell, render loop

### Reference (eksisterende kode, ikke forudsætning)
- `src/webgpu/splat-shader.ts` (Ward 7) — det shader-modul vi bypasser
- `src/webgpu/radix-sort-*.ts` (Ward 12) — sort-pipeline der bypasses men ikke slettes
- Ward 19's deferred spec — som historisk kontekst for hvorfor pivoten skete

## Outputs
- `src/webgpu/point-shader.ts` — minimal WGSL point shader (`@vertex` + `@fragment`)
- `src/webgpu/point-pipeline.ts` — `GPURenderPipeline` for point-topologi med depth-test enabled
- Render loop opdatering i `src/app/main.ts` — feature flag `RENDER_MODE = "points" | "splats"` (default: "points")
- Radix sort dispatch bag flag, ikke fjernet (Ward 23 fjerner den endeligt)
- Depth-stencil attachment tilføjet til render pass

## Specification
1. **WGSL point shader:**
   - Vertex: `position_clip = viewProj * vec4f(xyz, 1.0)`; `point_size` udregnes fra konstant pixel-bredde i Ward 20 (variabel/perspektiv-korrekt i Ward 23)
   - Fragment: returnér `vec4f(1.0, 1.0, 1.0, 1.0)` som placeholder (Ward 22 introducerer color-ramp)
   - Brug `topology: "point-list"` — ingen quads, ingen UV, ingen Gaussian-falloff
2. **Pipeline:**
   - `depthStencil`: `format: "depth24plus"`, `depthWriteEnabled: true`, `depthCompare: "less"`
   - Ingen alpha-blending — opaque pixels via hardware Z (modsat Ward 19's premultiplied-blend)
3. **Render-mode skift:**
   - Feature flag (`RENDER_MODE`) på `main.ts`-niveau
   - "splats"-grenen bevarer eksisterende adfærd (regression-sikring)
   - "points"-grenen er default fra og med Ward 20
4. **Sort-bypass:**
   - Radix-dispatch wrappet i `if (RENDER_MODE === "splats")`
   - Ingen ændring til `radix-sort.ts` modulet — kun call-site

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `point_pipeline_uses_point_list_topology` | `GPURenderPipelineDescriptor.primitive.topology === "point-list"` |
| T2 | `point_pipeline_has_depth_stencil_attached` | `depthStencil.format === "depth24plus"`, `depthWriteEnabled === true` |
| T3 | `point_shader_compiles_without_errors` | Mock `compilationInfo()` rapporterer ingen errors |
| T4 | `render_mode_points_bypasses_radix_dispatch` | I "points"-mode er der ingen call til `radixSort.dispatch()` |
| T5 | `render_mode_splats_still_calls_radix_dispatch` | Regression: "splats"-mode bevarer Ward 19 adfærd |
| T6 | `point_vertex_shader_uses_xyz_only` | Bind group eksponerer kun `splat-positions` (ingen `sh-coefficients`/`opacity` buffers) |
| T7 | `render_pass_clears_depth_to_1` | `depthClearValue === 1.0`, `depthLoadOp === "clear"` |

### Manual Visual Verification (AI Vision Gate)

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | Indlæs 142K cactus PLY (XYZ only) i "points"-mode | Hvide pixels i cactus-form, ingen Gaussian-falloff |
| V2 | Roter kamera | Punkter respekterer depth — bagsiden er ikke synlig gennem forsiden |
| V3 | Toggle flag tilbage til "splats" | Ward 19's gamle rendering virker uændret (regression-test) |

## Must NOT
- Slette `splat-shader.ts` eller `radix-sort.ts` — de skal blot bypass'es
- Introducere LAS/LAZ parsing (det er Ward 21)
- Implementere intensity color (det er Ward 22)
- Variable point size eller pixel-perfekt størrelser (det er Ward 23)
- Brække Ward 19's eksisterende 142K-cactus rendering (regression-gate)

## Must DO
- Bevare ECS, OPFS og Worker bridge uændret
- Tilføj `RENDER_MODE` feature flag dokumenteret i CLAUDE.md eller `.wdd/CONTEXT.md`
- Skrive WGSL shader ud fra de etablerede konventioner i `src/webgpu/`
- Sikre at depth-stencil attachment ikke brækker eksisterende color-attachments

## Verification
- T1-T7 grønne i Vitest
- V1-V3 visuelt verificeret i browser (AI Vision gate per epic-mandat)
- Manuelt: ingen frame drops på 142K PLY i "points"-mode
- QA1 godkender at "splats"-mode stadig fungerer (regression)
