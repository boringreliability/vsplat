# SuperSplat / PlayCanvas Engine — 3DGS Rendering Analysis

**Date:** 2026-04-05
**Purpose:** Identify patterns, optimizations, and architectural decisions in production 3DGS renderers to inform vsplat development.

---

## 1. Fragment Shader — normExp (Gaussian Falloff)

**File:** `engine/src/scene/shader-lib/wgsl/chunks/gsplat/frag/gsplat.js` (92 lines)

**What it does:** Evaluates Gaussian falloff in fragment shader using a normalized exponential. Instead of raw `exp(-0.5 * conic)`, they normalize to [0,1] range and use UV-space distance (not screen-space pixel distance).

**Key code:**
```wgsl
const EXP4: half = exp(half(-4.0));
const INV_EXP4: half = half(1.0) / (half(1.0) - EXP4);

fn normExp(x: half) -> half {
    return (exp(x * half(-4.0)) - EXP4) * INV_EXP4;
}

// In fragment main:
let A: half = dot(gaussianUV, gaussianUV);
if (A > half(1.0)) { discard; }
var alpha: half = normExp(A) * gaussianColor.a;
```

**What vsplat can learn:**
- **No conic in fragment shader.** PlayCanvas pre-computes the UV transformation in vertex shader so the fragment only needs `dot(uv, uv)` — a single instruction instead of our 5-term `A*dx² + 2B*dx*dy + C*dy²`. The ellipse is already "unwrapped" to a circle in UV space.
- **`half` precision throughout.** They use `half` (f16) for all fragment computation. We use f32. Half-precision halves register pressure and memory bandwidth.
- **Normalized range [0,1].** `normExp` maps the Gaussian to exactly [0,1] which avoids the exp-overflow issues we had.

---

## 2. Vertex Shader — Covariance Projection (gsplatCorner)

**File:** `engine/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatCorner.js` (149 lines)

**What it does:** Computes 3D covariance from rotation+scale, projects to 2D via Jacobian, computes eigenvalues for quad sizing, and transforms to UV space so the fragment shader only needs `dot(uv, uv)`.

**Key code:**
```wgsl
fn computeCovariance(rotation: half4, scale: half3, covA_ptr, covB_ptr) {
    let rot: half3x3 = quatToMat3(rotation);
    let s: vec3f = vec3f(scale);
    // M = S * R (promote to f32 for dot products)
    let M: mat3x3f = transpose(mat3x3f(s.x * vec3f(rot[0]), s.y * vec3f(rot[1]), s.z * vec3f(rot[2])));
    *covA_ptr = vec3f(dot(M[0], M[0]), dot(M[0], M[1]), dot(M[0], M[2]));
    *covB_ptr = vec3f(dot(M[1], M[1]), dot(M[1], M[2]), dot(M[2], M[2]));
}

// Projection:
let J1 = focal / vp.z;
let J2 = -J1 / vp.z * vp.xy;
let J = mat3x3f(vec3f(J1, 0.0, J2.x), vec3f(0.0, J1, J2.y), vec3f(0.0, 0.0, 0.0));
let W = transpose(mat3x3f(center.modelView[0].xyz, ...));
let T = W * J;
let cov = transpose(T) * Vrk * T;

// Anti-aliasing: +0.3 on diagonal (same as us!)
let diagonal1 = cov[0][0] + 0.3;
let diagonal2 = cov[1][1] + 0.3;

// Eigenvalues via mid+radius formula
let mid = 0.5 * (diagonal1 + diagonal2);
let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
let lambda1 = mid + radius;
let lambda2 = max(mid - radius, 0.1);  // clamp lambda2 to prevent degenerate

// Quad sizing with viewport-relative clamp
let vmin = min(1024.0, min(viewport.x, viewport.y));
let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);

// UV output: eigenvector-aligned axes
let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
let v1 = l1 * diagonalVector;
let v2 = l2 * vec2f(diagonalVector.y, -diagonalVector.x);
corner.offset = (cornerUV.x * v1 + cornerUV.y * v2) * clipSpaceScale;
corner.uv = cornerUV;
```

**What vsplat can learn:**
- **Eigenvector-aligned quads, not axis-aligned.** PlayCanvas computes the eigenvectors of the 2D covariance and aligns the quad axes to them. This means the quad is a tight-fitting rotated rectangle around the ellipse, not an axis-aligned square. Our quads are axis-aligned squares sized by `lambda_max` — wastes fill rate on elongated splats.
- **UV-space output.** `corner.uv = cornerUV` (which is `[-1,1]²`). Because the quad is eigenvector-aligned, the UV coordinates directly map to the normalized Gaussian — so the fragment shader just does `dot(uv, uv)` instead of the full conic equation. This is the key optimization that eliminates conic from the fragment shader.
- **`2.0 * sqrt(2.0 * lambda)` sizing.** They use `2√(2λ)` ≈ `2.83σ` instead of our `3σ`. Slightly tighter quads = less overdraw. The `normExp` function compensates by normalizing the falloff.
- **Viewport-relative size clamp:** `min(1024, min(viewport.x, viewport.y))` instead of our fixed 512px.
- **minPixelSize early-out.** They cull splats smaller than a configurable minimum pixel size. We don't — tiny splats waste GPU time for invisible contributions.
- **Frustum culling per-splat.** `abs(proj.xy) - size * c > proj.ww` culls splats outside the frustum in the vertex shader. We don't frustum-cull in the shader.
- **lambda2 clamp to 0.1.** Prevents degenerate thin ellipses that would cause numerical issues. We don't clamp lambda2.

---

## 3. Sort Worker

**File:** `engine/src/scene/gsplat/gsplat-sort-worker.js` (315 lines)

**What it does:** CPU-based radix sort in a Web Worker. Sorts splats by camera-space depth on-demand when camera moves. Uses a 32-bin histogram for coarse distribution sort with variable-width keys (10-20 bits based on vertex count).

**Key code:**
```javascript
const epsilon = 0.001;
if (!forceUpdate &&
    Math.abs(px - lastCameraPosition.x) < epsilon &&
    Math.abs(py - lastCameraPosition.y) < epsilon &&
    Math.abs(pz - lastCameraPosition.z) < epsilon &&
    Math.abs(dx - lastCameraDirection.x) < epsilon &&
    Math.abs(dy - lastCameraDirection.y) < epsilon &&
    Math.abs(dz - lastCameraDirection.z) < epsilon) {
    return;  // Camera didn't move — skip sort
}

// Variable key width based on count
const n = Math.ceil(Math.log2(numVertices));  // 10-20 bits
const maxKey = (1 << n) - 1;

// 32-bin histogram sort (not full radix)
const numBins = 32;
```

**What vsplat can learn:**
- **CPU sort, not GPU sort.** PlayCanvas sorts on CPU in a Worker, not on GPU. This is simpler and avoids the 24-dispatch GPU pipeline we built. For < 1M splats, CPU sort in a Worker may be faster than GPU sort + readback.
- **Camera change epsilon 0.001.** Same pattern as our `cameraChanged()` but they also check direction, not just position.
- **Variable key width.** Instead of 32-bit keys with 8 radix passes, they use `ceil(log2(count))` bits — 20 bits for 1M splats = 2-3 radix passes instead of 8. Massive sort speedup.
- **32-bin coarse histogram.** Not a full 256-bucket radix sort. Much simpler, still O(n).

---

## 4. SH Evaluation

**File:** `engine/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatEvalSH.js` (75 lines)

**What it does:** Evaluates Spherical Harmonics bands 1-3 in the vertex shader. Band 0 (DC) is handled separately. Uses `half` precision throughout. SH coefficients are passed as `array<half3, SH_COEFFS>`.

**Key code:**
```wgsl
fn evalSH(sh: ptr<function, array<half3, SH_COEFFS>>, dir: vec3f) -> half3 {
    let d: half3 = half3(dir);

    // 1st degree — NOTE: sign convention differs from standard!
    var result: half3 = SH_C1 * (-sh[0] * d.y + sh[1] * d.z - sh[2] * d.x);

    // 2nd degree
    result += sh[3] * (SH_C2_0 * xy) + sh[4] * (SH_C2_1 * yz) + ...

    // 3rd degree
    result += sh[8] * (SH_C3_0 * d.y * (3.0 * xx - yy)) + ...

    return result;
}
```

**What vsplat can learn:**
- **Sign convention.** PlayCanvas negates `d.y` and `d.x` in band 1: `(-sh[0]*d.y + sh[1]*d.z - sh[2]*d.x)`. Our implementation uses `(sh[0]*y + sh[1]*z + sh[2]*x)`. This sign difference may cause incorrect SH colors in vsplat.
- **`half3` precision.** SH coefficients and results are `half` (f16). Reduces bandwidth and register pressure.
- **Band 0 (DC) is not in evalSH.** DC is handled separately as base color. The function only adds bands 1-3 delta. Same pattern as our `SH_C0 * dc + 0.5` being separate.
- **Compile-time band selection.** `#if SH_BANDS > N` controls which bands are evaluated. No runtime branching.
- **15 coefficients, not 16.** They use SH coefficients 0-14 (bands 1-3), not 0-15. Our implementation uses 16 basis functions — might have an off-by-one in SH3.

---

## 5. SuperSplat Fragment Shader

**File:** `supersplat/src/shaders/splat-shader.ts` (282 lines)

**What it does:** SuperSplat's custom shader extends PlayCanvas with editor-specific features: selection highlighting, ring mode visualization, saturation/brightness controls, and state-based rendering (selected, locked, deleted).

**Key code:**
```glsl
// Same normExp as engine:
float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

// Edit state from texture (3 bits):
int state = int(texelFetch(splatState, dataUV, 0).r * 255.0);
bool isSelected = (state & 1) != 0;
bool isLocked   = (state & 2) != 0;
bool isDeleted  = (state & 4) != 0;

// SH with rotation support:
color.xyz += evalSH(sh, dir) * scale;
```

**What vsplat can learn:**
- **State stored in texture, not buffer.** SuperSplat packs edit state (selected/locked/deleted) into a texture, not a `Uint8Array` buffer. This allows the shader to read state without a separate storage buffer binding. Texture sampling is often faster than buffer access for random reads.
- **3-bit state matches our `Visibility` bitflags** (VISIBLE=1, SELECTED=2, DELETED=4). Same convention.
- **Saturation/brightness as uniform controls.** Per-scene (not per-splat) color adjustment. Useful for editor UX.

---

## Summary: Top 5 Things to Steal

| # | What | From | Impact |
|---|------|------|--------|
| 1 | **Eigenvector-aligned quads + UV-space Gaussian** | gsplatCorner.js | Eliminates conic from fragment shader. Reduces fragment ALU from 5 ops to 1 `dot(uv,uv)`. Tighter quads = less overdraw. |
| 2 | **`half` precision everywhere** | All shaders | Halves register pressure and memory bandwidth. WebGPU supports `f16` extension. |
| 3 | **SH sign convention fix** | gsplatEvalSH.js | Our SH band 1 signs may be wrong — `(-y, +z, -x)` vs our `(+y, +z, +x)`. Could explain incorrect view-dependent colors. |
| 4 | **Variable-width sort keys** | gsplat-sort-worker.js | `ceil(log2(count))` bits instead of 32 = fewer radix passes. Or: CPU sort in Worker may be faster than GPU sort for < 1M. |
| 5 | **Frustum cull + minPixelSize in vertex shader** | gsplatCorner.js | Skip tiny and off-screen splats before fragment stage. Free performance. |
