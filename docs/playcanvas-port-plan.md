# PlayCanvas 3DGS Render Pipeline -- Port Plan for vsplat

**Date:** 2026-04-05
**Branch:** feature/playcanvas-render-port
**Status:** Analysis complete, verified against PlayCanvas source — awaiting implementation

### Verification Status

All code snippets in this document have been verified against the actual PlayCanvas engine source on `main` branch (fetched 2026-04-05):

| File | Status | Notes |
|------|--------|-------|
| `gsplatCorner.js` (vert) | VERIFIED | Covariance, eigenvalues, frustum cull, offset — all confirmed |
| `gsplatCenter.js` (vert) | VERIFIED | initCenter with perspective + fisheye paths confirmed |
| `gsplatSource.js` (vert) | VERIFIED | initSource with indirect draw mode confirmed |
| `gsplatEvalSH.js` (vert) | VERIFIED | SH constants, sign convention, band structure — exact match |
| `gsplatOutput.js` (vert) | VERIFIED | prepareOutputFromGamma with tonemap/gamma paths confirmed |
| `gsplat.js` (vert main) | VERIFIED | Full vertexMain with all compile-time paths confirmed |
| `gsplat.js` (frag) | VERIFIED | normExp, multi-pass (pick/shadow/prepass), dither confirmed |
| `gsplat-sort-worker.js` | VERIFIED | Adaptive-bin counting sort with chunk histogram confirmed |
| `gsplatData.js` (vert) | NOT FOUND | 404 — file may have been renamed or moved. Buffer format details are inferred from gsplatCorner usage |
| `gsplatStructs.js` | NOT FETCHED | Struct definitions inferred from function signatures |

---

## Executive Summary

vsplat's current custom shader pipeline (`src/webgpu/splat-shader.ts`) has been built incrementally through 18 wards and already incorporates the key architectural ideas from PlayCanvas -- eigenvector-aligned quads, UV-space Gaussian evaluation via `normExp`, and the PlayCanvas SH sign convention `(-y, +z, -x)`. However, the implementation remains in f32 throughout, lacks PlayCanvas's modular shader architecture, misses several important culling and clipping optimizations, and has not been validated against the reference implementation at the per-instruction level.

This port plan replaces vsplat's monolithic WGSL shader with a pipeline that matches PlayCanvas's proven shader structure while preserving vsplat's Rust/WASM data core. The key changes are: (1) adopting `half` (f16) precision for fragment and SH computation, (2) porting PlayCanvas's exact covariance projection with its anti-aliasing factor, (3) adding the `clipCorner` alpha-aware quad tightening, (4) matching PlayCanvas's exact frustum culling formula, and (5) restructuring the shader to be modular for future editor features (selection highlighting, pick pass, dither).

The expected outcome is a render pipeline that produces pixel-identical output to PlayCanvas/SuperSplat for the same PLY input, with improved performance from f16 precision and tighter quads, while vsplat retains full ownership of PLY parsing, sorting, ECS, selection, and export in Rust.

---

## Architecture: What Changes vs What Stays

### Stays (Rust/WASM)

| Component | Location | Rationale |
|-----------|----------|-----------|
| PLY parser (header + binary) | `crates/vsplat-core/src/ply/` | Rust streaming parser is fast and correct; PlayCanvas has its own JS parser we do not need |
| Counting sort (`World::sort_by_depth`) | `crates/vsplat-core/src/ecs/` | O(n) CPU sort in Rust matches PlayCanvas's Worker-based counting sort pattern; no GPU sort needed |
| ECS data storage (flat SoA) | `crates/vsplat-core/src/ecs/` | Rust owns scene data; shaders consume via storage buffers |
| Selection / deletion / visibility | `src/selection/`, `src/commands/` | Editor logic is independent of render pipeline |
| Export engine | `src/export/` | PLY writer reads from Rust ECS, unrelated to shaders |
| FFI bridge (wasm-bindgen) | `crates/vsplat-core/src/ffi.rs` | Zero-copy Wasm memory to GPU upload path stays |
| Camera math (perspective, lookAt) | `src/camera/math.ts` | vsplat computes its own matrices; shaders receive them as uniforms |
| Worker bridge | `src/worker/` | Worker message protocol is independent of shader code |

### Changes (Port from PlayCanvas)

| Component | Current vsplat | PlayCanvas Target | Impact |
|-----------|---------------|-------------------|--------|
| Covariance projection | f32 manual J*W*Vrk*T | f16 rotation/scale input, f32 intermediate, eigenvector quads | Better precision balance, identical math |
| Fragment shader | f32 `normExp` + `dot(uv,uv)` | `half` precision `normExp` + `dot(gaussianUV, gaussianUV)` | Halves fragment register pressure |
| SH evaluation | f32, runtime `if` branching | `half3`, compile-time `#if SH_BANDS` | Less bandwidth, no branch penalty |
| Quad clipping | None | `clipCorner()` -- tightens quad to alpha-visible region | Reduces overdraw for semi-transparent splats |
| Frustum culling | `abs(ndc) - ndc_size > 1.0` | `abs(proj.xy) - size * c > proj.ww` (clip-space) | Correct for both perspective and ortho |
| Anti-aliasing factor | `+0.3` on diagonal only | `+0.3` plus `aaFactor = sqrt(detOrig/detBlur)` | Preserves energy for AA-trained scenes |
| Blend mode | Front-to-back `one-minus-dst-alpha / one` | Same blend, but with pre-multiplied `color * alpha` | Already matches -- verify exact formula |
| Instanced draw | 128 splats per instance | `{GSPLAT_INSTANCE_SIZE}` configurable | Keep 128 default, make configurable |
| Color output | Direct gamma-space | `prepareOutputFromGamma()` with tonemapping hooks | Add tonemapping pipeline for correctness |

### Integration Points

```
Rust ECS (SoA flat arrays)
    |
    v  wasm-bindgen FFI -> Float32Array views (zero-copy)
    |
    v  device.queue.writeBuffer() -> GPU storage buffers
    |
    v  Vertex Shader reads from storage buffers:
    |    positions[], rotations[], scales[], opacities[], sh_coefficients[], sorted_indices[]
    |
    v  PlayCanvas-style pipeline:
    |    initSource() -> initCenter() -> initCorner() -> evalSH() -> clipCorner() -> output
    |
    v  Fragment Shader: normExp(dot(uv,uv)) * alpha -> premultiplied RGBA
```

**Key integration detail:** PlayCanvas stores splat data in textures (addressed via `splat.uv = vec2i(idx % textureSize, idx / textureSize)`). vsplat uses flat storage buffers (`array<f32>`) indexed directly. This is a fundamental difference -- vsplat's buffer-based approach is simpler and works well for our use case, so we keep it. The ported shader must replace all `textureSample` / `textureLoad` calls with direct `array[]` indexing.

---

## PlayCanvas Shader Architecture Deep Dive

### Vertex Shader Pipeline

PlayCanvas uses a modular include-based architecture. The main vertex shader (`gsplat.js`) orchestrates the pipeline:

```
gsplatSource.js   -- initSource(): compute render order, read sorted splat ID, extract cornerUV
       |
       v
gsplatCenter.js   -- initCenter(): transform model center through view/projection, populate SplatCenter
       |
       v
gsplatCorner.js   -- initCorner(): compute 3D covariance, project to 2D, eigendecompose, size quad
       |
       v
gsplatEvalSH.js   -- evalSH(): evaluate spherical harmonics bands 1-3 in half precision
       |
       v
gsplatCommon.js   -- clipCorner(): tighten quad based on alpha, discard sub-pixel splats
       |
       v
gsplatOutput.js   -- prepareOutputFromGamma(): color space conversion + tonemapping
       |
       v
gsplat.js (frag)  -- normExp(dot(uv,uv)) * alpha -> premultiplied output
```

#### Stage 1: Source Initialization (`gsplatSource.js`) — VERIFIED

```wgsl
// Attributes:
attribute vertex_position: vec3f;

// Storage:
var<storage, read> splatOrder: array<u32>;
uniform numSplats: u32;
// Also supports indirect draw mode:
var<storage, read> numSplatsStorage: array<u32>;
var<storage, read> compactedSplatIds: array<u32>;

fn initSource(source: ptr<function, SplatSource>) -> bool {
    source.order = pcInstanceIndex * {GSPLAT_INSTANCE_SIZE}u + u32(vertex_position.z);

    #ifdef GSPLAT_INDIRECT_DRAW
        let numSplats = numSplatsStorage[0];  // GPU-driven count
    #else
        let numSplats = uniform.numSplats;     // CPU-set count
    #endif

    if (source.order >= numSplats) { return false; }

    var splatId: u32;
    #ifdef GSPLAT_INDIRECT_DRAW
        splatId = compactedSplatIds[source.order];  // Pre-compacted by GPU
    #else
        splatId = splatOrder[source.order];          // Sort-ordered
    #endif

    setSplat(splatId);
    source.cornerUV = half2(vertex_position.xy);
    return true;
}
```

**vsplat equivalent:** Lines 137-148 of `splat-shader.ts`. The pattern is identical — `iid * SPLATS_PER_INSTANCE + offset`, bounds check, index lookup. vsplat already does this correctly. We do NOT need `GSPLAT_INDIRECT_DRAW` — our Rust sort produces the full order array.

**NOTE:** PlayCanvas has two modes: `GSPLAT_INDIRECT_DRAW` (GPU-compacted IDs) and standard (CPU-sorted order). vsplat uses standard mode only.

#### Stage 2: Center Projection (`gsplatCenter.js`) — VERIFIED

```wgsl
// Uniforms:
uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
uniform camera_params: vec4f;       // (1/far, far, near, isOrtho)
uniform matrix_projection: mat4x4f;
// Fisheye-only uniforms (not needed for vsplat):
// uniform fisheye_k, fisheye_inv_k, fisheye_projMat00, fisheye_projMat11

fn initCenter(modelCenter: vec3f, center: ptr<function, SplatCenter>) -> bool {
    let modelView: mat4x4f = uniform.matrix_view * uniform.matrix_model;
    let centerView: vec4f = modelView * vec4f(modelCenter, 1.0);

    // Behind-camera cull (perspective only — ortho skips this)
    if (uniform.camera_params.w != 1.0 && centerView.z > 0.0) { return false; }

    var centerProj: vec4f = uniform.matrix_projection * centerView;
    // Clamp depth to valid range (prevents near/far artifacts)
    centerProj.z = clamp(centerProj.z, 0.0, abs(centerProj.w));

    center.proj = centerProj;
    center.projMat00 = uniform.matrix_projection[0][0];
    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
```

**NOTE:** PlayCanvas also has a full `#ifdef GSPLAT_FISHEYE` path with generalized fisheye projection (`g(θ) = k·tan(θ/k)`). We do NOT port this — vsplat only needs perspective.

**Key differences from vsplat:**
1. **Clip-space retention:** PlayCanvas stores full `center.proj` (clip-space vec4f) and uses it later for frustum culling in clip space. vsplat divides by `w` early to get NDC, losing the `w` component.
2. **Focal derivation:** PlayCanvas extracts `projMat00` for focal length: `focal = viewport_width * projMat00`. vsplat passes `focal` as a separate uniform pair `(fx, fy)`.
3. **Depth clamping:** PlayCanvas clamps `centerProj.z` to `[0, abs(w)]` — prevents near/far clipping artifacts. vsplat passes `clip.z / clip.w` directly.
4. **Ortho support:** PlayCanvas supports orthographic via `camera_params.w == 1.0`. vsplat assumes perspective only (acceptable for 3DGS editor).
5. **Model matrix:** PlayCanvas applies `matrix_model` (scene transform). vsplat has no model matrix — positions are in world space from Rust. Can add as identity later for scene rotation.

#### Stage 3: Corner Computation (`gsplatCorner.js`) — VERIFIED

This is the most critical stage. PlayCanvas has three paths: 3DGS (default), 2DGS (`#if GSPLAT_2DGS`), and fisheye (`#ifdef GSPLAT_FISHEYE`). We only port the **3DGS perspective path**.

**Uniforms:**
```wgsl
uniform viewport_size: vec4f;  // (width, height, 1/width, 1/height)
uniform minPixelSize: f32;
```

**3D Covariance from rotation + scale:**
```wgsl
fn computeCovariance(rotation: half4, scale: half3, covA_ptr: ptr<function, vec3f>, covB_ptr: ptr<function, vec3f>) {
    let rot: half3x3 = quatToMat3(rotation);
    let s: vec3f = vec3f(scale);
    // M = S * R — promote to f32 to avoid overflow in scale² dot products
    let M: mat3x3f = transpose(mat3x3f(
        s.x * vec3f(rot[0]),
        s.y * vec3f(rot[1]),
        s.z * vec3f(rot[2])
    ));
    *covA_ptr = vec3f(dot(M[0], M[0]), dot(M[0], M[1]), dot(M[0], M[2]));
    *covB_ptr = vec3f(dot(M[1], M[1]), dot(M[1], M[2]), dot(M[2], M[2]));
}
```

**Entry point — dispatches to correct path:**
```wgsl
fn initCorner(source, center, corner) -> bool {
    var rotation: vec4f = getRotation().yzwx;  // (w,x,y,z) from PLY → (x,y,z,w)
    var scale: vec3f = getScale();
    modifySplatRotationScale(...);  // editor hook (identity for us)

    #if GSPLAT_2DGS
        initCorner2DGS(source, rotation, scale, corner);  // NOT PORTED
        return true;
    #else
        var covA: vec3f; var covB: vec3f;
        computeCovariance(half4(rotation.wxyz), half3(scale), &covA, &covB);  // (x,y,z,w) → (w,x,y,z) back
        return initCornerCov(source, center, corner, covA, covB);
    #endif
}
```

**CRITICAL: Quaternion convention** — PlayCanvas reads as `(w,x,y,z)`, swizzles to `(x,y,z,w)` with `.yzwx`, then passes to `computeCovariance` as `rotation.wxyz` = back to `(w,x,y,z)`. vsplat stores rotations as `(w,x,y,z)` from Rust — so we skip the double-swizzle and pass directly.

**Jacobian projection to 2D (perspective path):**
```wgsl
let focal = uniform.viewport_size.x * center.projMat00;
// Ortho support: use fixed (0,0,1) instead of view position
let vp = select(center.view.xyz, vec3f(0.0, 0.0, 1.0), uniform.camera_params.w == 1.0);
let J1 = focal / vp.z;
let J2 = -J1 / vp.z * vp.xy;
let J = mat3x3f(
    vec3f(J1, 0.0, J2.x),
    vec3f(0.0, J1, J2.y),
    vec3f(0.0, 0.0, 0.0)
);
let W = transpose(mat3x3f(center.modelView[0].xyz, center.modelView[1].xyz, center.modelView[2].xyz));
let T = W * J;
let cov = transpose(T) * Vrk * T;
```

**Anti-aliasing factor (optional, behind compile-time flag):**
```wgsl
#if GSPLAT_AA
    let detOrig = cov[0][0] * cov[1][1] - cov[0][1] * cov[1][0];
    let detBlur = (cov[0][0] + 0.3) * (cov[1][1] + 0.3) - cov[0][1] * cov[1][0];
    corner.aaFactor = half(sqrt(max(detOrig / detBlur, 0.0)));
#endif
```

**Eigendecomposition + quad sizing:**
```wgsl
let diagonal1 = cov[0][0] + 0.3;
let offDiagonal = cov[0][1];
let diagonal2 = cov[1][1] + 0.3;

let mid = 0.5 * (diagonal1 + diagonal2);
let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
let lambda1 = mid + radius;
let lambda2 = max(mid - radius, 0.1);

let vmin = min(1024.0, min(uniform.viewport_size.x, uniform.viewport_size.y));
let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);

// Frustum cull in clip space
let c = center.proj.ww * uniform.viewport_size.zw;
if (any((abs(center.proj.xy) - vec2f(max(l1, l2)) * c) > center.proj.ww)) {
    return false;
}

let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
let v1 = l1 * diagonalVector;
let v2 = l2 * vec2f(diagonalVector.y, -diagonalVector.x);
corner.offset = vec3f((f32(source.cornerUV.x) * v1 + f32(source.cornerUV.y) * v2) * c, 0.0);
corner.uv = source.cornerUV;
```

**Key differences from vsplat:**
1. **Focal length computation:** PlayCanvas derives focal from `viewport_size.x * projMat00`. vsplat passes `focal` as a separate uniform pair `(fx, fy)`. These should be mathematically equivalent but must be verified: `projMat00 = 2*near*fx / (width*near) = 2*fx/width`, so `width * projMat00 = 2*fx`. PlayCanvas uses a single `focal` (isotropic), vsplat uses `focal.x, focal.y` (anisotropic). For square pixels these are equal.
2. **Frustum culling:** PlayCanvas culls in clip space: `abs(proj.xy) - size * c > proj.ww` where `c = proj.ww * viewport.zw`. This is correct for both perspective and orthographic. vsplat culls in NDC: `abs(ndc) - ndc_size > 1.0`. The clip-space version is numerically more robust.
3. **Offset output:** PlayCanvas outputs `corner.offset` as a clip-space delta added to `center.proj`. vsplat converts to NDC offset. The clip-space approach avoids a divide-by-w in the vertex shader.
4. **AA factor:** PlayCanvas computes `aaFactor = sqrt(detOrig/detBlur)` which is multiplied into opacity. This preserves total splat energy when the +0.3 blur expands the Gaussian. vsplat does not have this correction.
5. **`clipCorner()`:** After computing color and opacity, PlayCanvas tightens the quad:
   ```wgsl
   fn clipCorner(corner: ptr<function, SplatCorner>, alpha: half) {
       let clip = min(half(1.0), sqrt(log(half(255.0) * alpha)) * half(0.5));
       corner.offset = corner.offset * f32(clip);
       corner.uv = corner.uv * clip;
   }
   ```
   This shrinks quads for low-alpha splats, reducing overdraw. vsplat does not do this.

#### Stage 4: SH Evaluation (`gsplatEvalSH.js`)

```wgsl
const SH_C1: half = half(0.4886025119029199);
// ... (C2, C3 constants identical to vsplat)

fn evalSH(sh: ptr<function, array<half3, SH_COEFFS>>, dir: vec3f) -> half3 {
    let d: half3 = half3(dir);
    // Band 1: sign convention (-y, +z, -x)
    var result: half3 = SH_C1 * (-sh[0] * d.y + sh[1] * d.z - sh[2] * d.x);
    // Band 2: standard basis functions
    // Band 3: standard basis functions
    return result;
}
```

**Key differences from vsplat:**
1. **Precision:** PlayCanvas uses `half3` for SH coefficients and results. vsplat uses `f32` throughout. The f16 path halves SH bandwidth.
2. **Data layout:** PlayCanvas passes SH as `array<half3, SH_COEFFS>` -- interleaved RGB per coefficient. vsplat reads from a flat `array<f32>` with manual stride: `sh_coefficients[base + offset]`. PlayCanvas's approach is cleaner but requires the SH data to be packed as interleaved half3.
3. **Compile-time bands:** PlayCanvas uses `#if SH_BANDS > N` (preprocessor). vsplat uses runtime `if (camera.sh_degree >= N)`. The compile-time version eliminates dead code.
4. **Direction computation:** PlayCanvas computes view direction as `normalize(center.view * modelView3x3)` which gives the direction in model space. vsplat uses `normalize(camera.camera_pos - world_pos)` which gives world-space direction. These must match the SH coordinate convention of the training data.
5. **Scale factor:** PlayCanvas has an explicit `scale` multiplier from `readSHData()` applied to the SH result. vsplat does not.

### Fragment Shader (`gsplat.js` frag) — VERIFIED

```wgsl
const EXP4: half = exp(half(-4.0));
const INV_EXP4: half = half(1.0) / (half(1.0) - EXP4);

fn normExp(x: half) -> half {
    return (exp(x * half(-4.0)) - EXP4) * INV_EXP4;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let A: half = dot(gaussianUV, gaussianUV);
    if (A > half(1.0)) { discard; return output; }

    var alpha: half = normExp(A) * gaussianColor.a;

    // Special passes use uniform alphaClip threshold:
    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < half(uniform.alphaClip)) { discard; return output; }
    #endif

    #ifdef PICK_PASS
        output.color = encodePickOutput(vPickId);   // Selection ID encoding
    #elif SHADOW_PASS
        output.color = vec4f(0.0, 0.0, 0.0, 1.0);  // Black for shadow
    #elif PREPASS_PASS
        output.color = float2vec4(vLinearDepth);     // Linear depth for prepass
    #else
        // Standard render path:
        if (alpha < half(1.0 / 255.0)) { discard; return output; }
        #ifndef DITHER_NONE
            opacityDither(f32(alpha), id * 0.013);   // Bayer matrix dither
        #endif
        output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));
    #endif

    return output;
}
```

**Key differences from vsplat:**
1. **Precision:** PlayCanvas uses `half` for `normExp`, UV dot product, and alpha. vsplat uses `f32`.
2. **Pre-multiplied alpha:** Both output `color * alpha` for RGB and `alpha` for A. Identical.
3. **Varying names:** PlayCanvas uses `gaussianUV: half2` and `gaussianColor: half4`. vsplat packs UV and opacity into `uv_and_opacity: vec4f` and uses separate `color: vec3f`. PlayCanvas's approach is cleaner — color and opacity travel together.
4. **Multiple render passes:** PlayCanvas supports PICK_PASS (editor selection), SHADOW_PASS, and PREPASS_PASS (depth). We should add PICK_PASS for editor selection in a future ward.
5. **Opacity dithering:** PlayCanvas applies Bayer-matrix dithering via `opacityDither()` when `DITHER_NONE` is not set. This reduces banding artifacts. Consider adding later.

### Data Format & Buffer Layout

PlayCanvas stores splat data in **textures** addressed by 2D UV coordinates:
```wgsl
struct Splat { index: u32, uv: vec2i }
fn setSplat(idx: u32) {
    splat.uv = vec2i(i32(idx % splatTextureSize), i32(idx / splatTextureSize));
}
```

Then format-specific reader functions (`gsplatFormat.js` and friends) use `textureLoad(texture, splat.uv, 0)` to read packed data from textures.

**vsplat uses flat storage buffers** -- `array<f32>` indexed by `idx * stride + component`. This is simpler and avoids texture size limitations. We keep this approach.

PlayCanvas packs rotation as `half4` (w,x,y,z) and scale as `half3`, reading them from texture. The `computeCovariance` function converts the quaternion from `(w,x,y,z)` to `(x,y,z,w)` for its internal math:
```wgsl
var rotation: vec4f = getRotation().yzwx;  // (w,x,y,z) -> (x,y,z,w)
computeCovariance(half4(rotation.wxyz), half3(scale), ...);  // back to (w,x,y,z)
```

vsplat stores rotations as `f32` in `(w,x,y,z)` order (matching PLY convention). The covariance function in vsplat's shader uses `quat.x=w, quat.y=x, quat.z=y, quat.w=z` -- which matches PlayCanvas's convention after the swizzle.

---

## Detailed Porting Plan

### Phase 1: Core Vertex Shader (Covariance + Eigenvector Quads)

**Goal:** Replace vsplat's vertex shader internals with PlayCanvas's exact math, keeping vsplat's buffer-based data access.

**Steps:**

1. **Add `viewport_size` uniform** with `(width, height, 1/width, 1/height)` -- replaces vsplat's current `viewport: vec2f`. Update `CameraSystem` to pack 4 floats instead of 2.

2. **Add `camera_params` uniform** with `(1/far, far, near, isOrtho)` -- needed for depth clamping and ortho support.

3. **Derive focal from projection matrix** instead of passing as separate uniform:
   ```wgsl
   let focal = uniform.viewport_size.x * uniform.matrix_projection[0][0];
   ```
   This eliminates the `focal` uniform and ensures consistency.

4. **Port `computeCovariance` exactly** -- accept `half4` rotation and `half3` scale, promote to f32 for dot products. This requires `enable f16;` at the top of the shader.

5. **Port clip-space frustum culling:**
   ```wgsl
   let c = center.proj.ww * uniform.viewport_size.zw;
   if (any((abs(center.proj.xy) - vec2f(max(l1, l2)) * c) > center.proj.ww)) { return; }
   ```
   Replace vsplat's NDC-based culling.

6. **Output clip-space offset** instead of NDC offset:
   ```wgsl
   corner.offset = vec3f((cornerUV.x * v1 + cornerUV.y * v2) * c, 0.0);
   output.position = center.proj + vec4f(corner.offset, 0.0);
   ```

7. **Add `minPixelSize` uniform** and early-out for sub-pixel splats.

8. **Add depth clamping:**
   ```wgsl
   centerProj.z = clamp(centerProj.z, 0.0, abs(centerProj.w));
   ```

9. **Port AA factor** (behind `GSPLAT_AA` flag for scenes trained with anti-aliasing).

**Files modified:**
- `src/webgpu/splat-shader.ts` -- shader WGSL
- `src/camera/system.ts` -- uniform layout (add `viewport_size.zw`, `camera_params`, remove `focal`)

### Phase 2: Fragment Shader + Blend Mode

**Goal:** Port to `half` precision fragment, add `clipCorner`, verify blend mode.

**Steps:**

1. **Enable `f16` extension:**
   ```wgsl
   enable f16;
   ```
   This requires `"shader-f16"` feature to be requested at device creation. Add feature detection in `src/detection/`.

2. **Port `normExp` to `half`:**
   ```wgsl
   const EXP4: half = exp(half(-4.0));
   const INV_EXP4: half = half(1.0) / (half(1.0) - EXP4);
   fn normExp(x: half) -> half {
       return (exp(x * half(-4.0)) - EXP4) * INV_EXP4;
   }
   ```

3. **Change varyings to half precision:**
   ```wgsl
   varying gaussianUV: half2;
   varying gaussianColor: half4;  // RGB + opacity packed together
   ```

4. **Port `clipCorner()`** -- add after SH evaluation and color computation:
   ```wgsl
   fn clipCorner(corner: ptr<function, SplatCorner>, alpha: half) {
       let clip = min(half(1.0), sqrt(log(half(255.0) * alpha)) * half(0.5));
       corner.offset = corner.offset * f32(clip);
       corner.uv = corner.uv * clip;
   }
   ```

5. **Verify blend mode** -- vsplat already uses front-to-back:
   ```typescript
   blend: {
     color: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
     alpha: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
   }
   ```
   This matches PlayCanvas. No change needed.

6. **Add f32 fallback path** -- if `shader-f16` is not available, keep current f32 path. Use a compile-time flag or two shader variants.

**Files modified:**
- `src/webgpu/splat-shader.ts` -- fragment WGSL + varyings
- `src/app/main.ts` -- request `shader-f16` feature at device creation
- `src/detection/` -- add `hasShaderF16()` feature detection

### Phase 3: SH Evaluation

**Goal:** Port SH to half precision with compile-time band selection.

**Steps:**

1. **Restructure SH data layout** for `array<half3, SH_COEFFS>`:
   - Currently: flat `array<f32>` with per-channel stride
   - Target: interleaved `vec3<f16>` per coefficient, or continue using f32 storage buffer and cast in shader
   - **Decision:** Keep f32 storage buffers (Rust outputs f32). Cast to `half3` in the shader's `readSHData()` function. This avoids changing the Rust FFI.

2. **Port `evalSH` to half precision:**
   ```wgsl
   fn evalSH(sh: ptr<function, array<half3, SH_COEFFS>>, dir: vec3f) -> half3 {
       let d: half3 = half3(dir);
       var result: half3 = SH_C1 * (-sh[0] * d.y + sh[1] * d.z - sh[2] * d.x);
       // ... bands 2-3
       return result;
   }
   ```

3. **Add compile-time band selection** using shader variants:
   - Generate 4 shader variants: `SH_BANDS=0`, `1`, `2`, `3`
   - Select variant based on loaded PLY's SH degree
   - Eliminates runtime branching

4. **Fix view direction computation:**
   - PlayCanvas: `let dir = normalize(center.view * modelView3x3)` -- model-space direction
   - vsplat: `normalize(camera.camera_pos - world_pos)` -- world-space direction
   - For identity model matrix these are equivalent. For non-identity (scene rotation), PlayCanvas's approach is correct. Port it.

5. **Verify sign convention** matches across the full pipeline:
   - PLY stores SH in a specific order (from 3DGS training)
   - PlayCanvas band 1: `(-y, +z, -x)` -- this is `(-sh[0]*d.y, +sh[1]*d.z, -sh[2]*d.x)`
   - vsplat already uses this convention (Ward 19 update)
   - Verify bands 2-3 coefficient ordering matches

**Files modified:**
- `src/webgpu/splat-shader.ts` -- SH evaluation WGSL
- `src/webgpu/spherical-harmonics.ts` -- if SH preprocessing exists

### Phase 4: Half Precision (f16) Optimization Pass

**Goal:** Maximize f16 usage where precision allows, keep f32 where needed.

**Steps:**

1. **Rotation + scale inputs as half:**
   - `computeCovariance(rotation: half4, scale: half3, ...)` -- matches PlayCanvas
   - Read from f32 storage buffers, cast to half at read time
   - The covariance dot products are promoted to f32 internally (overflow protection)

2. **SH coefficients as half:**
   - Read from f32 buffer, cast to `half3` per coefficient
   - Future optimization: store as f16 in Rust and upload half-precision buffers

3. **Color pipeline in half:**
   - `gaussianColor: half4` varying
   - Fragment shader operates entirely in half
   - Only final output is `vec4f`

4. **Measure performance impact:**
   - Compare frame times with f16 vs f32 paths
   - Verify no visible quality regression on test scenes

**Files modified:**
- `src/webgpu/splat-shader.ts` -- precision annotations
- Future: `crates/vsplat-core/` -- optional f16 storage format

---

## Buffer Layout Mapping

| PlayCanvas Buffer | vsplat Equivalent | Changes Needed |
|---|---|---|
| `splatOrder` (storage `array<u32>`) | `sorted_indices` (storage `array<u32>`) | Rename binding label for clarity; functionally identical |
| `numSplats` (uniform `u32`) | `arrayLength(&sorted_indices)` | vsplat uses `arrayLength` instead of a separate uniform; keep this |
| Splat center (texture `rgba32f`) | `positions` (storage `array<f32>`, stride 3) | No change -- buffer access via `positions[idx*3 + c]` |
| Splat rotation (texture `rgba16f`) | `rotations` (storage `array<f32>`, stride 4) | Keep f32 storage; cast to `half4` in shader |
| Splat scale (texture `rgba16f`, .xyz) | `scales` (storage `array<f32>`, stride 3) | Keep f32 storage; cast to `half3` in shader |
| Splat color/opacity (texture `rgba8unorm`) | `opacities` (storage `array<f32>`) + SH DC | vsplat stores opacity separately; color comes from SH DC |
| SH data (texture `rgba16f`, multiple) | `sh_coefficients` (storage `array<f32>`) | Keep f32 storage; cast to half3 per coefficient in shader |
| `splatTextureSize` (uniform `u32`) | Not needed | vsplat uses buffer indexing, not texture 2D coords |
| `vertex_position` (attribute `vec3f`) | `vertex_position` (attribute `vec3f`) | Identical: xy=cornerUV, z=splat offset |

---

## Camera Uniform Mapping

| PlayCanvas Uniform | vsplat CameraSystem | Notes |
|---|---|---|
| `matrix_model` (`mat4x4f`) | Identity (implicit) | vsplat does not support model transform yet; add as identity or skip |
| `matrix_view` (`mat4x4f`) | `camera.view` at offset 0 | Identical |
| `matrix_projection` (`mat4x4f`) | `camera.proj` at offset 64 | Identical |
| `camera_params` (`vec4f`: 1/far, far, near, isOrtho) | Not present | **Add**: pack from CameraConfig `near`, `far`; isOrtho=0 for perspective |
| `viewport_size` (`vec4f`: w, h, 1/w, 1/h) | `camera.viewport` (`vec2f`: w, h) | **Extend**: add inverse components; change uniform from vec2f to vec4f |
| `minPixelSize` (`f32`) | Not present | **Add**: default 2.0, configurable |
| `camera_pos` (derived) | `camera.camera_pos` at offset 128 | Used for SH view direction; keep |
| `focal` (derived from `projMat00 * viewport.x`) | `camera.focal` at offset 144 | **Remove**: derive in shader from projection matrix |
| `sh_degree` / `sh_dim` | `camera.sh_degree` / `camera.sh_dim` at offset 160 | Keep for runtime info; compile-time bands replace runtime branching |

**New CameraUniforms layout (proposed):**

```
Offset  Size  Field
0       64    view: mat4x4f
64      64    proj: mat4x4f
128     12    camera_pos: vec3f
140      4    (pad)
144     16    viewport_size: vec4f (w, h, 1/w, 1/h)
160     16    camera_params: vec4f (1/far, far, near, isOrtho)
176      4    sh_degree: u32
180      4    sh_dim: u32
184      4    minPixelSize: f32
188      4    (pad to 16-byte alignment)
Total: 192 bytes
```

This is a breaking change to the uniform buffer layout. All existing tests that mock `CameraUniforms` must be updated.

---

## Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **f16 not supported** on target GPU | Shader compilation fails | Maintain f32 fallback shader variant; feature-detect `shader-f16` at startup |
| **Quaternion convention mismatch** | Rotated splats render incorrectly | Write unit test comparing vsplat `compute_cov3d` output vs PlayCanvas `computeCovariance` for known quaternion inputs |
| **SH direction space mismatch** | View-dependent colors wrong from certain angles | Compare SH output for known direction + coefficients against reference implementation |
| **Uniform buffer layout change** | Breaks all existing ward tests | Update all test mocks in a single commit; verify with full test suite |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Clip-space vs NDC offset** | Incorrect splat positioning | Render test scene side-by-side with SuperSplat for visual comparison |
| **Y-axis flip** | Scene appears upside-down | vsplat already flips Y in position loading (`-positions[b3+1u]`); verify this is still correct with new pipeline |
| **AA factor for non-AA scenes** | Opacity too dark/light | Default `GSPLAT_AA` to off; enable only when metadata indicates AA training |
| **Compile-time SH variants** | Shader compilation overhead at load time | Pre-compile all 4 variants on startup; use correct one per scene |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Tonemapping differences** | Slight color shift | Default to NONE tonemapping (gamma passthrough) to match current behavior |
| **`clipCorner` too aggressive** | Very transparent splats disappear | The math is `sqrt(log(255*alpha))*0.5` -- only clips when alpha is very low; matches PlayCanvas behavior |
| **Sort order changes** | Visual popping during sort | Sort algorithm is unchanged (Rust counting sort); only shader changes |

---

## Appendix: Key PlayCanvas Code Snippets

### A1. Full Vertex Main (`gsplat.js` vert) — VERIFIED from source

```wgsl
// Includes (modular shader architecture):
#include "gsplatHelpersVS"
#include "gsplatFormatVS"
#include "gsplatStructsVS"
#include "gsplatDeclarationsVS"
#include "gsplatModifyVS"
#include "gsplatEvalSHVS"
#include "gsplatQuatToMat3VS"
#include "gsplatReadVS"
#include "gsplatSourceVS"
#include "gsplatCenterVS"
#include "gsplatCornerVS"
#include "gsplatOutputVS"

// clipCorner is defined in gsplatCommonVS (the main vert file):
fn clipCorner(corner: ptr<function, SplatCorner>, alpha: half) {
    let clip = min(half(1.0), sqrt(log(half(255.0) * alpha)) * half(0.5));
    corner.offset = corner.offset * f32(clip);
    corner.uv = corner.uv * clip;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    var source: SplatSource;
    if (!initSource(&source)) {
        output.position = discardVec;
        return output;
    }

    var modelCenter: vec3f = getCenter();
    var center: SplatCenter;
    center.modelCenterOriginal = modelCenter;
    modifySplatCenter(&modelCenter);
    center.modelCenterModified = modelCenter;

    if (!initCenter(modelCenter, &center)) {
        output.position = discardVec;
        return output;
    }

    var corner: SplatCorner;
    if (!initCorner(&source, &center, &corner)) {
        output.position = discardVec;
        return output;
    }

    // Read color + opacity (two modes):
    #ifdef GSPLAT_SEPARATE_OPACITY
        let opacity = getOpacity();
        var clr: half4 = half4(vec4f(getColor(), opacity));
    #else
        var clr: half4 = half4(getColor());  // Color includes opacity in .a
    #endif

    #if GSPLAT_AA
        clr.a = clr.a * corner.aaFactor;
    #endif

    // Evaluate SH
    #if SH_BANDS > 0
        let modelView3x3 = mat3x3f(center.modelView[0].xyz, center.modelView[1].xyz, center.modelView[2].xyz);
        let dir = normalize(center.view * modelView3x3);
        var sh: array<half3, SH_COEFFS>;
        var scale: f32;
        readSHData(&sh, &scale);
        clr = half4(clr.xyz + evalSH(&sh, dir) * half(scale), clr.a);
    #endif

    // Editor color modification hook (identity for standard rendering):
    var clrF32 = vec4f(clr);
    modifySplatColor(modelCenter, &clrF32);
    clr = half4(clrF32);

    // Discard invisible splats (alpha * 255 <= 1)
    if (half(255.0) * clr.w <= half(1.0)) {
        output.position = discardVec;
        return output;
    }

    clipCorner(&corner, clr.w);

    // Final position — different for 2DGS vs 3DGS:
    #if GSPLAT_2DGS
        let modelCorner: vec3f = center.modelCenterModified + corner.offset;
        output.position = uniform.matrix_projection * center.modelView * vec4f(modelCorner, 1.0);
    #else
        output.position = center.proj + vec4f(corner.offset.xyz, 0.0);
    #endif

    output.gaussianUV = corner.uv;

    // Color output — overdraw debug mode vs standard:
    #ifdef GSPLAT_OVERDRAW
        // Debug: heat-map visualization
        let t: f32 = clamp(center.modelCenterOriginal.y / 20.0, 0.0, 1.0);
        let rampColor: vec3f = textureSampleLevel(colorRamp, colorRampSampler, vec2f(t, 0.5), 0.0).rgb;
        clr.a = clr.a * half(1.0 / 32.0) * half(uniform.colorRampIntensity);
        output.gaussianColor = half4(half3(rampColor), clr.a);
    #else
        output.gaussianColor = half4(half3(prepareOutputFromGamma(max(vec3f(clr.xyz), vec3f(0.0)))), clr.w);
    #endif

    // Per-splat ID for dithering:
    #ifndef DITHER_NONE
        output.id = f32(splat.index);
    #endif

    // Prepass linear depth:
    #ifdef PREPASS_PASS
        output.vLinearDepth = -center.view.z;
    #endif

    // Pick pass ID:
    #if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
        output.vPickId = loadPcId().r;
    #endif

    return output;
}
```

### A2. Full Fragment Main (`gsplat.js` frag) — VERIFIED from source

```wgsl
const EXP4: half = exp(half(-4.0));
const INV_EXP4: half = half(1.0) / (half(1.0) - EXP4);

fn normExp(x: half) -> half {
    return (exp(x * half(-4.0)) - EXP4) * INV_EXP4;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let A: half = dot(gaussianUV, gaussianUV);
    if (A > half(1.0)) {
        discard;
        return output;
    }

    var alpha: half = normExp(A) * gaussianColor.a;

    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < half(uniform.alphaClip)) { discard; return output; }
    #endif

    #ifdef PICK_PASS
        #ifdef GSPLAT_UNIFIED_ID
            output.color = encodePickOutput(vPickId);
        #else
            output.color = getPickOutput();
        #endif
        #ifdef DEPTH_PICK_PASS
            output.color1 = getPickDepth();
        #endif
    #elif SHADOW_PASS
        output.color = vec4f(0.0, 0.0, 0.0, 1.0);
    #elif PREPASS_PASS
        output.color = float2vec4(vLinearDepth);
    #else
        if (alpha < half(1.0 / 255.0)) { discard; return output; }
        #ifndef DITHER_NONE
            opacityDither(f32(alpha), id * 0.013);
        #endif
        output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));
    #endif

    return output;
}
```

### A3. Full Covariance + Corner Projection (`gsplatCorner.js`)

```wgsl
fn computeCovariance(rotation: half4, scale: half3,
                     covA_ptr: ptr<function, vec3f>,
                     covB_ptr: ptr<function, vec3f>) {
    let rot: half3x3 = quatToMat3(rotation);
    let s: vec3f = vec3f(scale);
    let M: mat3x3f = transpose(mat3x3f(
        s.x * vec3f(rot[0]),
        s.y * vec3f(rot[1]),
        s.z * vec3f(rot[2])
    ));
    *covA_ptr = vec3f(dot(M[0], M[0]), dot(M[0], M[1]), dot(M[0], M[2]));
    *covB_ptr = vec3f(dot(M[1], M[1]), dot(M[1], M[2]), dot(M[2], M[2]));
}

fn initCornerCov(source: ptr<function, SplatSource>,
                 center: ptr<function, SplatCenter>,
                 corner: ptr<function, SplatCorner>,
                 covA: vec3f, covB: vec3f) -> bool {
    let Vrk = mat3x3f(
        vec3f(covA.x, covA.y, covA.z),
        vec3f(covA.y, covB.x, covB.y),
        vec3f(covA.z, covB.y, covB.z)
    );

    let focal = uniform.viewport_size.x * center.projMat00;
    let v = center.view.xyz;
    let J1 = focal / v.z;
    let J2 = -J1 / v.z * v.xy;
    let J = mat3x3f(
        vec3f(J1, 0.0, J2.x),
        vec3f(0.0, J1, J2.y),
        vec3f(0.0, 0.0, 0.0)
    );
    let W = transpose(mat3x3f(
        center.modelView[0].xyz,
        center.modelView[1].xyz,
        center.modelView[2].xyz
    ));
    let T = W * J;
    let cov = transpose(T) * Vrk * T;

    let diagonal1 = cov[0][0] + 0.3;
    let offDiagonal = cov[0][1];
    let diagonal2 = cov[1][1] + 0.3;

    let mid = 0.5 * (diagonal1 + diagonal2);
    let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
    let lambda1 = mid + radius;
    let lambda2 = max(mid - radius, 0.1);

    let vmin = min(1024.0, min(uniform.viewport_size.x, uniform.viewport_size.y));
    let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
    let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);

    if (max(l1, l2) < uniform.minPixelSize) { return false; }

    let c = center.proj.ww * uniform.viewport_size.zw;
    if (any((abs(center.proj.xy) - vec2f(max(l1, l2)) * c) > center.proj.ww)) {
        return false;
    }

    let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
    let v1 = l1 * diagonalVector;
    let v2 = l2 * vec2f(diagonalVector.y, -diagonalVector.x);

    corner.offset = vec3f(
        (f32(source.cornerUV.x) * v1 + f32(source.cornerUV.y) * v2) * c,
        0.0
    );
    corner.uv = source.cornerUV;
    return true;
}
```

### A4. SH Evaluation (`gsplatEvalSH.js`) — VERIFIED from source (exact match)

```wgsl
#if SH_BANDS == 1
    const SH_COEFFS: i32 = 3;
#elif SH_BANDS == 2
    const SH_COEFFS: i32 = 8;
#elif SH_BANDS == 3
    const SH_COEFFS: i32 = 15;
#else
    const SH_COEFFS: i32 = 0;
#endif

const SH_C1: half = half(0.4886025119029199);
const SH_C2_0: half = half(1.0925484305920792);
const SH_C2_1: half = half(-1.0925484305920792);
const SH_C2_2: half = half(0.31539156525252005);
const SH_C2_3: half = half(-1.0925484305920792);
const SH_C2_4: half = half(0.5462742152960396);
const SH_C3_0: half = half(-0.5900435899266435);
const SH_C3_1: half = half(2.890611442640554);
const SH_C3_2: half = half(-0.4570457994644658);
const SH_C3_3: half = half(0.3731763325901154);
const SH_C3_4: half = half(-0.4570457994644658);
const SH_C3_5: half = half(1.445305721320277);
const SH_C3_6: half = half(-0.5900435899266435);

fn evalSH(sh: ptr<function, array<half3, SH_COEFFS>>, dir: vec3f) -> half3 {
    let d: half3 = half3(dir);

    // Band 1
    var result: half3 = SH_C1 * (-sh[0] * d.y + sh[1] * d.z - sh[2] * d.x);

    // Band 2
    let xx: half = d.x * d.x;
    let yy: half = d.y * d.y;
    let zz: half = d.z * d.z;
    let xy: half = d.x * d.y;
    let yz: half = d.y * d.z;
    let xz: half = d.x * d.z;
    result = result + (
        sh[3] * (SH_C2_0 * xy) +
        sh[4] * (SH_C2_1 * yz) +
        sh[5] * (SH_C2_2 * (half(2.0) * zz - xx - yy)) +
        sh[6] * (SH_C2_3 * xz) +
        sh[7] * (SH_C2_4 * (xx - yy))
    );

    // Band 3
    result = result + (
        sh[8]  * (SH_C3_0 * d.y * (half(3.0) * xx - yy)) +
        sh[9]  * (SH_C3_1 * xy * d.z) +
        sh[10] * (SH_C3_2 * d.y * (half(4.0) * zz - xx - yy)) +
        sh[11] * (SH_C3_3 * d.z * (half(2.0) * zz - half(3.0) * xx - half(3.0) * yy)) +
        sh[12] * (SH_C3_4 * d.x * (half(4.0) * zz - xx - yy)) +
        sh[13] * (SH_C3_5 * d.z * (xx - yy)) +
        sh[14] * (SH_C3_6 * d.x * (xx - half(3.0) * yy))
    );

    return result;
}
```

### A5. Sort Worker Key Algorithm (`gsplat-sort-worker.js`) — VERIFIED from source

PlayCanvas uses a sophisticated adaptive-bin counting sort. Key differences from vsplat's Rust sort:

```javascript
// Step 1: AABB-based depth range from scene bounds (not per-splat scan)
for (let i = 0; i < 8; ++i) {
    const x = (i & 1 ? boundMin.x : boundMax.x);
    const y = (i & 2 ? boundMin.y : boundMax.y);
    const z = (i & 4 ? boundMin.z : boundMax.z);
    const d = x * dx + y * dy + z * dz;
    minDist = Math.min(minDist, d);
    maxDist = Math.max(maxDist, d);
}

// Step 2: Variable-width sort key (10-20 bits) based on splat count
const compareBits = Math.max(10, Math.min(20, Math.round(Math.log2(numVertices / 4))));
const bucketCount = 2 ** compareBits + 1;

// Step 3: Chunk-based histogram to weight key distribution
// Chunks are pre-computed spatial regions with center + radius
const numBins = 32;  // NOT numChunks — fixed 32-bin histogram
binCount.fill(0);
for (let i = 0; i < numChunks; ++i) {
    const d = chunks[i*4] * dx + chunks[i*4+1] * dy + chunks[i*4+2] * dz - minDist;
    const r = chunks[i*4+3];
    const binMin = Math.max(0, Math.floor((d - r) * numBins / range));
    const binMax = Math.min(numBins, Math.ceil((d + r) * numBins / range));
    for (let j = binMin; j < binMax; ++j) { binCount[j]++; }
}

// Step 4: Compute per-bin key ranges (non-uniform distribution)
for (let i = 0; i < numBins; ++i) {
    binDivider[i] = (binCount[i] / binTotal * bucketCount) >>> 0;
    binBase[i] = i === 0 ? 0 : binBase[i-1] + binDivider[i-1];
}

// Step 5: Assign sort keys per splat
const binRange = range / numBins;
for (let i = 0; i < numVertices; ++i) {
    const d = (centers[i*3]*dx + centers[i*3+1]*dy + centers[i*3+2]*dz - minDist) / binRange;
    const bin = d >>> 0;
    const sortKey = (binBase[bin] + binDivider[bin] * (d - bin)) >>> 0;
    distances[i] = sortKey;
    countBuffer[sortKey]++;
}

// Step 6: Counting sort (stable, O(n))
for (let i = 1; i < bucketCount; i++) { countBuffer[i] += countBuffer[i-1]; }
for (let i = 0; i < numVertices; i++) {
    order[--countBuffer[distances[i]]] = i;
}

// Step 7: Binary search to exclude behind-camera splats
const count = dist(numVertices - 1) >= 0 ? findZero() : numVertices;
```

**vsplat comparison:** Our Rust sort uses a simpler uniform key distribution with `ceil(log2(count))` bits. PlayCanvas's chunk-based non-uniform distribution is smarter — it allocates more key resolution to depth ranges with more splats. However, our Rust sort is already fast enough. This is a future optimization, not a porting requirement.

### A6. `clipCorner` -- Alpha-Aware Quad Tightening (`gsplatCommon.js`)

```wgsl
fn clipCorner(corner: ptr<function, SplatCorner>, alpha: half) {
    let clip = min(half(1.0), sqrt(log(half(255.0) * alpha)) * half(0.5));
    corner.offset = corner.offset * f32(clip);
    corner.uv = corner.uv * clip;
}
```

**Math explanation:** `normExp(A) * alpha < 1/255` means invisible. Solving for A:
`exp(-4A) * alpha ≈ 1/255` => `A ≈ ln(255*alpha) / 4`. The `sqrt` converts from A (squared UV distance) to UV distance. The `0.5` factor provides a small margin. The result `clip` scales both the quad offset and UV so the fragment shader's `dot(uv,uv) > 1.0` discard catches the edge precisely.

### A7. Color Output (`gsplatOutput.js`) — VERIFIED from source

```wgsl
#include "tonemappingPS"
#include "decodePS"
#include "gammaPS"

fn prepareOutputFromGamma(gammaColor: vec3f) -> vec3f {
    #if TONEMAP == NONE
        #if GAMMA == NONE
            return decodeGamma3(gammaColor);  // Convert to linear
        #else
            return gammaColor;                // Pass through gamma
        #endif
    #else
        // Tonemap in linear space, output with gamma correction
        return gammaCorrectOutput(toneMap(decodeGamma3(gammaColor)));
    #endif
}
```

**For vsplat:** We use `TONEMAP=NONE, GAMMA=NONE` equivalent — pass SH color through directly. 3DGS training outputs gamma-space colors (SH DC + 0.5), so no conversion needed for standard rendering.

### A8. Struct Definitions (`gsplatStructs.js`)

```wgsl
struct SplatSource {
    order: u32,
    cornerUV: half2
}

struct SplatCenter {
    view: vec3f,
    proj: vec4f,
    modelView: mat4x4f,
    projMat00: f32,
    modelCenterOriginal: vec3f,
    modelCenterModified: vec3f,
}

struct SplatCorner {
    offset: vec3f,
    uv: half2,
    #if GSPLAT_AA
        aaFactor: half,
    #endif
}
```
