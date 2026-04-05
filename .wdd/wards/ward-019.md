---
ward: 19
revision: 1
name: "Production Rendering"
epic: "production-hardening"
status: "in-progress"
dependencies: [7, 8, 12, 18]
layer: "typescript+wgsl"
estimated_tests: 8
created: "2026-04-05"
---
# Ward 019: Production Rendering

## Problem Statement

Ward 18 proved the pipeline works end-to-end. A cactus renders. But it renders poorly and slowly compared to production 3DGS renderers like SuperSplat/PlayCanvas:

1. **Performance:** 2M splats hang the system. SuperSplat renders the same scene smooth. Our vertex shader computes covariance + conic + SH per vertex (4× per splat = 8M invocations). Fragment shader evaluates 5-term conic equation. Draw budget caps at 500K splats (26% of scene).

2. **Quality:** Splats look muddy compared to SuperSplat. Flower patterns on the pot are invisible. Cactus spines lack individual detail. View-dependent lighting is absent. Root causes: SH band 1 sign convention is wrong (`+y, +z, +x` vs PlayCanvas `−y, +z, −x`), SH degree hardcoded to 0 (DC only), axis-aligned quads waste fill rate on elongated splats.

3. **Architecture:** Fragment shader evaluates full conic form (`A·dx² + 2B·dx·dy + C·dy²` = 5 ALU ops) using screen-space pixel coordinates. PlayCanvas sends eigenvector-aligned UV coordinates from vertex shader — fragment does `dot(uv, uv)` (1 op). This eliminates conic from fragment, reduces overdraw via tighter quads, and removes the fragile `center`/`dx` coordinate space dependency.

Ward 19 matches or exceeds SuperSplat quality at full splat count with smooth framerate. This is the ward that determines whether vsplat is worth continuing.

## Reference Analysis

Analysis of SuperSplat (MIT) and PlayCanvas Engine (MIT) source code completed. Full report: `docs/supersplat-analysis.md`. Key findings:

| Finding | PlayCanvas Approach | vsplat Current | Impact |
|---------|-------------------|----------------|--------|
| Quad alignment | Eigenvector-aligned rotated rectangle | Axis-aligned square sized by λ_max | 2-4× overdraw reduction |
| Fragment Gaussian | `dot(uv, uv)` — 1 op | `A·dx² + 2B·dx·dy + C·dy²` — 5 ops | 5× fragment ALU reduction |
| SH band 1 signs | `(−y, +z, −x)` | `(+y, +z, +x)` | Colors wrong/muddy |
| SH degree | Compile-time band selection, up to SH3 | Hardcoded degree 0 | No view-dependent color |
| Gaussian normalization | `normExp`: normalized to [0,1], no overflow | Raw `exp(power)`, overflow possible | Stability + quality |
| Size clamping | `2√(2λ)` ≈ 2.83σ + viewport-relative clamp | `3√λ_max` + fixed 512px cap | Tighter fit, adaptive |
| Frustum culling | Per-splat clip-space cull in vertex shader | None | Free perf on off-screen splats |
| Min pixel size | Configurable minimum, skip tiny splats | None | Skip invisible splats |
| Precision | `half` (f16) throughout fragment | `f32` throughout | 2× register/bandwidth |
| Sort | CPU Worker, on camera change, variable key width | GPU radix 24 dispatches, on camera change | Simpler, non-blocking |

## Scope

Rewrite the splat rendering pipeline to match production quality. Three phases, each independently testable:

### Phase 1: SH Fix (Quality — immediate visual improvement)
- Fix SH band 1 sign convention: `(−y, +z, −x)`
- Wire correct SH band count from PLY metadata (`shDim 3→0, 12→1, 27→2, 48→3`)
- Update CPU reference (`spherical-harmonics.ts`) to match
- **Gate:** 142K cactus shows view-dependent color changes when orbiting

### Phase 2: Eigenvector-Aligned Quads + UV-Space Gaussian (Performance + Quality)
- Compute eigenvectors of 2D covariance in vertex shader
- Align quad axes to eigenvectors (rotated rectangle, not axis-aligned square)
- Output normalized UV coordinates (`corner.uv = cornerUV` in `[-1,1]²`)
- Replace fragment conic evaluation with `dot(uv, uv)`
- Implement `normExp` for stable [0,1] Gaussian falloff
- Size quads with `2√(2λ)` instead of `3√λ_max`
- **Gate:** Fragment shader contains zero conic parameters. Elongated splats render as tight ellipses, not oversized squares.

### Phase 3: Performance Hardening (Full splat count)
- Per-splat frustum culling in vertex shader: `abs(ndc.xy) - size > 1.0 → discard`
- Minimum pixel size culling: skip splats smaller than 2px
- `lambda2` clamp to 0.1 (prevent degenerate thin splats)
- Viewport-relative radius clamp: `min(sqrt(2*lambda), min(viewport.x, viewport.y))`
- Remove draw budget — render all splats
- Anti-aliasing: `+0.3` on 2D covariance diagonal (matches PlayCanvas)
- **Gate:** 2M splats render at 30+ fps without system hang. All splats visible.

## Inputs

- Ward 7: `splat-shader.ts` — current shader (will be rewritten)
- Ward 8: `CameraSystem` — camera uniforms
- Ward 12: Radix sort pipeline (unchanged)
- Ward 18: `main.ts` app shell, `depth-keys.ts`, render loop
- `docs/supersplat-analysis.md` — reference implementation analysis
- PlayCanvas Engine source: `engine/src/scene/shader-lib/wgsl/chunks/gsplat/`
- SuperSplat source: `supersplat/src/shaders/splat-shader.ts`

## Outputs

### Modified: `src/webgpu/splat-shader.ts`

Vertex shader changes:
```wgsl
// Eigenvector computation (new)
let diag = vec2f(cov_a - cov_c, 2.0 * cov_b);
let eigenDir = normalize(vec2f(diag.y, lambda1 - cov_a));

// Eigenvector-aligned quad sizing (new)
let l1 = 2.0 * sqrt(2.0 * lambda1);
let l2 = 2.0 * sqrt(2.0 * lambda2);
let v1 = l1 * eigenDir;
let v2 = l2 * vec2f(eigenDir.y, -eigenDir.x);

// Quad offset (replaces axis-aligned offset)
let offset = (cornerUV.x * v1 + cornerUV.y * v2) / viewport * 2.0;

// Output UV instead of center (new)
out.uv = cornerUV;  // replaces out.center
```

Fragment shader changes:
```wgsl
// normExp (replaces conic evaluation)
const EXP4: f32 = exp(-4.0);
const INV_EXP4: f32 = 1.0 / (1.0 - EXP4);

fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let A = dot(in.uv, in.uv);
    if (A > 1.0) { discard; }
    let alpha = min(normExp(A) * in.opacity, 0.999);
    if (alpha < 1.0 / 255.0) { discard; }
    return vec4f(in.color * alpha, alpha);
}
```

SH band 1 sign fix:
```wgsl
// Degree 1: signs match PlayCanvas convention
color += SH_C1 * (-y) * vec3f(sh[b1], sh[b1+1u], sh[b1+2u]);
color += SH_C1 * z * vec3f(sh[b1+3u], sh[b1+4u], sh[b1+5u]);
color += SH_C1 * (-x) * vec3f(sh[b1+6u], sh[b1+7u], sh[b1+8u]);
```

### Modified: `src/webgpu/spherical-harmonics.ts`

CPU reference updated to match shader sign convention.

### Modified: `src/webgpu/gaussian-math.ts`

CPU reference updated: `computeCovariance3D` no longer calls `Math.exp()` (Rust handles it). Eigenvector computation added as reference function.

### Modified: `src/app/main.ts`

- `camera.setSH(shBands, shDim)` wired with correct band count
- Draw budget removed (`pass.draw(4, splatCount)`)

### New: `src/webgpu/splat-shader.test.ts` (or extended)

Contract tests verifying CPU and GPU agree on eigenvector computation, UV mapping, and normExp output.

## Tests

### Automated Tests (Vitest)

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `sh_band1_sign_convention_matches_playcanvas` | SH degree 1 evaluation with direction (1,0,0) produces same result as PlayCanvas reference |
| T2 | `sh_degree_from_dim` | `shDim 3→bands 0`, `12→1`, `27→2`, `48→3` mapping correct |
| T3 | `eigenvector_aligned_quad_tighter_than_axis_aligned` | For an elongated 2D covariance (ratio 10:1), eigenvector quad area < axis-aligned quad area |
| T4 | `normExp_range_zero_to_one` | `normExp(0) ≈ 1.0`, `normExp(1) ≈ 0.0`, all values in [0,1] |
| T5 | `normExp_matches_gaussian_at_center_and_edge` | `normExp(0) = 1.0` (center), `normExp(1) ≈ 0` (edge), monotonically decreasing |
| T6 | `uv_space_gaussian_matches_conic_form` | For a known covariance, `dot(uv,uv)` via eigenvector transform produces same alpha as conic evaluation |
| T7 | `frustum_cull_discards_offscreen` | Splat at NDC (2.0, 0.0) is culled; splat at NDC (0.5, 0.5) is not |
| T8 | `lambda2_clamp_prevents_degenerate` | Covariance with near-zero lambda2 clamps to 0.1, produces valid quad |

### Manual Visual Verification

| # | Check | Expected Result |
|---|-------|-----------------|
| V1 | 142K PLY: orbit camera | View-dependent color changes visible (SH working) |
| V2 | 142K PLY: compare to SuperSplat | Flower patterns on pot visible, cactus spines detailed |
| V3 | 2M PLY: load and render | All splats visible, no draw budget, 30+ fps |
| V4 | 2M PLY: orbit smoothly | No system hang, no frame drops below 20fps |
| V5 | Elongated splats | Thin splats render as tight ellipses, not oversized squares |

## Non-Outputs

- Does NOT change sort pipeline (GPU radix sort stays for now)
- Does NOT add LOD or progressive rendering
- Does NOT add `half` (f16) precision (requires WebGPU extension negotiation)
- Does NOT add tonemapping or post-processing
- Does NOT add pre-compute pass (covariance still computed in vertex shader, but 5× cheaper fragment compensates)

## Must NOT

- Break existing 184 tests
- Change Rust parser or data pipeline (Ward 18 made it clean)
- Change ECS or Worker bridge
- Add new GPU buffer bindings (reuse existing bind group layout if possible)
- Introduce runtime SH degree branching (use compile-time `#if` or `select()`)

## Must DO

- Fix SH band 1 signs to match PlayCanvas `(−y, +z, −x)` convention
- Wire SH band count from PLY metadata
- Implement eigenvector-aligned quads
- Replace conic fragment evaluation with `dot(uv, uv)`
- Implement `normExp` for stable Gaussian falloff
- Add per-splat frustum culling in vertex shader
- Add minimum pixel size culling
- Clamp `lambda2` to prevent degenerate splats
- Remove draw budget — render all splats
- Achieve 30+ fps with 2M splats

## Verification

### Green Criteria

1. All existing tests pass (184+)
2. New tests T1-T8 pass
3. Human verifies V1-V5 in browser
4. FPS counter shows 30+ fps with 2M PLY, stationary camera
5. Quality visually comparable to SuperSplat on same PLY file

### The Real Test

Ward 19 is complete when the 2M cactus PLY renders with visible flower patterns, individual cactus spines, view-dependent lighting, at 30+ fps, without system hang. If it doesn't match SuperSplat quality, the ward is not done.

## Relationship to Other Wards

### Upstream (consumed)
- Ward 7: Splat shader (rewritten in this ward)
- Ward 8: Camera system (unchanged, provides uniforms)
- Ward 12: Sort pipeline (unchanged)
- Ward 18: App shell, render loop, data pipeline (unchanged)

### Downstream (enables)
- Ward 20+: Selection tools can be wired once rendering is production-quality
- Performance profiling becomes meaningful with optimized rendering
- Export/edit features build on a renderer that actually works

### GS-TDD Principle Established in Ward 18
**Ward Boundary Contract Tests:** Any data format crossing a ward boundary must have an explicit contract test verifying producer and consumer agree on semantics. Ward 19 adds T6 (UV-space Gaussian matches conic form) as a cross-ward contract test between vertex and fragment shader semantics.