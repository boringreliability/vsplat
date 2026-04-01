---
ward: 14
revision: 1
name: "Unified SoA Material Core"
epic: "production-hardening"
status: "complete"
dependencies: [4, 5, 7]
layer: "rust+typescript"
estimated_tests: 11
created: "2026-04-01"
completed: "2026-04-01"
---
# Ward 014: Unified SoA Material Core

## Problem Statement

The material layer has two independent problems that compound into a data-scale blocker:

### Rust: Per-entity heap allocation for SH coefficients

`SplatMaterial` in `components.rs` stores SH coefficients as `Vec<f32>` per entity:

```rust
pub struct SplatMaterial {
    pub opacity: f32,
    pub sh_coefficients: Vec<f32>,  // 5M heap allocs for 5M splats
}
```

`World::batch_spawn_splats` calls `.to_vec()` per entity during PLY load:

```rust
sh_coefficients: data.sh_coefficients[sh_start..sh_end].to_vec(),
```

For 5M splats at SH degree 3 (48 coefficients per splat), this creates 5M separate heap allocations totaling ~960MB of data plus ~200MB of Vec overhead (pointer + length + capacity per Vec). The data already exists as a contiguous `Vec<f32>` in `SplatData.sh_coefficients` — the per-entity slicing is pure waste.

### TypeScript: No SH upload path to GPU

Ward 5's GPU bridge uploads only positions (`Float32Array` → `GPUBuffer`). Ward 7's splat shader reads `sh_coefficients` from a storage buffer binding, but no code exists to populate that buffer. The shader's `evaluate_sh()` function reads from `sh_coefficients[base + offset]` where `base = idx * camera.sh_dim` — this assumes a flat contiguous buffer indexed by `splat_index * sh_dim`, which is exactly the SoA layout that `SplatData` already has but that never reaches the GPU.

### Combined effect

The Rust side wastes memory fragmenting contiguous data into per-entity Vecs. The TypeScript side has no path to upload SH data at all. The shader expects a flat buffer that nobody creates. Ward 14 fixes both by making the material layer data-scale: flat contiguous SH buffers in Rust, and a GPU upload path in TypeScript that mirrors the position upload pattern from Ward 5.

## Scope

Restructure the material layer to use flat contiguous SoA buffers for SH coefficients and opacity. Eliminate per-entity `Vec<f32>` heap allocations. Add a TypeScript-side GPU buffer and upload path for SH data and opacity, following the same pattern as Ward 5's position buffer.

## Inputs

- Ward 3: `SplatData` — already has contiguous `sh_coefficients: Vec<f32>` and `opacities: Vec<f32>`
- Ward 4: `SplatMaterial`, `ComponentStore<SplatMaterial>`, `World::batch_spawn_splats`
- Ward 4: `tests.rs` — `batch_spawn_from_ply`, `transform_component_layout`
- Ward 5: `gpu-buffer.ts` — `GpuSplatBuffer`, `createGpuSplatBuffer`, `uploadSplatBuffer` pattern
- Ward 5: `wasm-memory.ts` — `WasmMemoryView` pattern
- Ward 7: `splat-shader.ts` — `sh_coefficients` storage buffer binding layout, `evaluate_sh(idx, dir)`

## Outputs

### Rust
- Restructured `SplatMaterial` — opacity moves to a flat `ComponentStore<f32>` or stays in SplatMaterial without Vec
- New `SHBuffer` — flat contiguous `Vec<f32>` owned by `World`, indexed by `entity_index * sh_dim`
- Updated `World::batch_spawn_splats` — zero-copy or single-memcpy from `SplatData` to `SHBuffer`
- `sh_dim` tracked at World level (uniform across all splats in a scene)

### TypeScript
- `src/webgpu/sh-buffer.ts` — `GpuSHBuffer`, `createGpuSHBuffer`, `uploadSHBuffer`
- `src/webgpu/opacity-buffer.ts` — `GpuOpacityBuffer`, `createGpuOpacityBuffer`, `uploadOpacityBuffer`
- Both follow Ward 5's dirty-flag pattern

## Non-Outputs

- Does NOT change the WGSL shader (Ward 7's `evaluate_sh` already reads flat SH buffer)
- Does NOT add wasm-bindgen FFI (Ward 15 scope)
- Does NOT change the PLY parser (Ward 3's `SplatData` is already optimal)
- Does NOT modify the render pipeline bind group layout (that's integration scope)

## Specification

### 1. Rust: Flat SH Buffer

Replace per-entity `Vec<f32>` with a World-owned flat buffer:

```rust
pub struct World {
    pub entities: EntityManager,
    pub transforms: ComponentStore<Transform>,
    pub opacities: Vec<f32>,          // flat: opacities[entity_index]
    pub sh_coefficients: Vec<f32>,    // flat: sh[entity_index * sh_dim + coeff]
    pub sh_dim: usize,                // uniform per scene (3, 12, 27, or 48)
    pub visibility: ComponentStore<Visibility>,
}
```

`SplatMaterial` as a component type is eliminated. Its data moves to flat arrays on `World`.

**Why not `ComponentStore<f32>` for opacity?** Opacity is a per-entity scalar that never needs swap-and-pop deletion (soft-delete via visibility flags, not data removal). A flat `Vec<f32>` indexed by entity index is simpler, faster, and GPU-upload-friendly. The same applies to SH coefficients.

**`batch_spawn_splats` change:** Instead of `.to_vec()` per entity, the implementation does a single `extend_from_slice` or `copy_from_slice` from `SplatData` into the World's flat buffers. For opacity: `self.opacities.extend_from_slice(&data.opacities)`. For SH: `self.sh_coefficients.extend_from_slice(&data.sh_coefficients)`.

**Indexing contract:** `sh_coefficients[entity_index * sh_dim + coeff_index]`. This matches Ward 7's WGSL shader: `sh_coefficients[idx * camera.sh_dim + offset]`. The index is the entity's dense array position, not the entity's generational ID.

**Index stability contract:** The 1:1 mapping between entity slot index and buffer position is valid because the current deletion model is soft-delete only (visibility flags, no data removal). No compaction occurs, so slot indices are stable for the lifetime of a scene. Any future feature that introduces compaction or slot remapping (export compaction, batch despawn with reclaim) MUST update this contract and the buffer indexing strategy explicitly.

**`sh_dim` invariant:** `sh_dim` is uniform across all splats in a scene. `batch_spawn_splats` must validate that `data.sh_dim` matches `self.sh_dim` if the world already contains splats. Mismatch is a hard error (panic/throw), not a silent truncation. An empty world initializes `sh_dim` from the first batch.

### 2. TypeScript: GPU Buffer for SH + Opacity

Following Ward 5's `GpuSplatBuffer` pattern:

```typescript
// sh-buffer.ts
export interface GpuSHBuffer {
  buffer: GPUBuffer;
  splatCount: number;
  shDim: number;
  dirty: boolean;
}

export function createGpuSHBuffer(
  device: GPUDevice, splatCount: number, shDim: number
): GpuSHBuffer;

export function uploadSHBuffer(
  device: GPUDevice, shBuffer: GpuSHBuffer, data: Float32Array
): void;
```

```typescript
// opacity-buffer.ts
export interface GpuOpacityBuffer {
  buffer: GPUBuffer;
  splatCount: number;
  dirty: boolean;
}

export function createGpuOpacityBuffer(
  device: GPUDevice, splatCount: number
): GpuOpacityBuffer;

export function uploadOpacityBuffer(
  device: GPUDevice, opacityBuffer: GpuOpacityBuffer, data: Float32Array
): void;
```

Both use `GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST` (same as position buffer). Both implement dirty-flag optimization (Ward 5 pattern: skip upload if not dirty).

**Buffer sizes:**
- SH: `splatCount * shDim * 4` bytes (f32 per coefficient)
- Opacity: `splatCount * 4` bytes (one f32 per splat)

### 3. Shader Compatibility

Ward 7's WGSL shader already declares:

```wgsl
@group(0) @binding(4) var<storage, read> sh_coefficients: array<f32>;
@group(0) @binding(3) var<storage, read> opacities: array<f32>;
```

And reads them with flat indexing:

```wgsl
let base = idx * camera.sh_dim;
// ...
SH_C0 * sh_coefficients[base] + 0.5,
```

The buffers created in this Ward will be bound to these bindings. No shader changes needed — the data layout matches by construction.

### 4. Data Flow

```
PLY file
  → Ward 3: SplatData { sh_coefficients: Vec<f32>, opacities: Vec<f32> }  [contiguous]
  → Ward 4: World.sh_coefficients.extend_from_slice(...)                  [single copy]
  → Ward 5 pattern: WasmMemoryView → GpuSHBuffer.uploadSHBuffer()        [GPU upload]
  → Ward 7: shader reads sh_coefficients[idx * sh_dim + offset]           [flat access]
```

Zero intermediate copies. Zero per-entity heap allocations. One contiguous buffer from parse to GPU.

## Tests

Tests are split across Rust (`crates/vsplat-core/src/ecs/tests.rs` additions) and TypeScript (`tests/ward-014/`).

### Category A: Rust — Flat Buffer Layout (Rust tests)

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `flat_sh_buffer_batch_spawn` | `batch_spawn_splats` populates `world.sh_coefficients` as flat contiguous buffer. Length = `count * sh_dim`. Values match `SplatData` input. |
| A2 | `flat_opacity_buffer_batch_spawn` | `batch_spawn_splats` populates `world.opacities` as flat Vec. Length = `count`. Values match `SplatData` input. |
| A3 | `flat_sh_indexing_matches_shader` | `world.sh_coefficients[i * sh_dim + c]` returns correct coefficient for entity `i`, coefficient `c`. Verified for first, middle, and last entity. |
| A4 | `no_per_entity_vec_allocation` | After `batch_spawn_splats`, `world.materials` ComponentStore is empty (SplatMaterial eliminated). SH data lives only in flat buffer. |
| A5 | `sh_dim_mismatch_throws` | World with existing `sh_dim = 48` rejects batch with `sh_dim = 27`. Empty world accepts any valid `sh_dim`. |

### Category B: TypeScript — GPU Buffer & Upload (TypeScript tests)

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `sh_buffer_created_correct_size` | `createGpuSHBuffer(device, 5_000_000, 48)` creates buffer of `5M * 48 * 4` bytes with STORAGE + COPY_DST. |
| B2 | `sh_buffer_upload_writes_data` | `uploadSHBuffer` calls `writeBuffer` with Float32Array data. Dirty flag resets to false after upload. |
| B3 | `sh_buffer_dirty_flag_skips_reupload` | Second `uploadSHBuffer` call without dirty reset is a no-op (writeBuffer not called again). |
| B4 | `opacity_buffer_created_correct_size` | `createGpuOpacityBuffer(device, 5_000_000)` creates buffer of `5M * 4` bytes. |
| B5 | `opacity_buffer_upload_writes_data` | `uploadOpacityBuffer` calls `writeBuffer` with Float32Array data. Dirty flag resets. |
| B6 | `invalid_splat_count_throws` | Both `createGpuSHBuffer` and `createGpuOpacityBuffer` throw `RangeError` for `<= 0` or non-integer splatCount. |

## Must NOT

- Keep `Vec<f32>` per entity in `SplatMaterial` (the entire point of this Ward)
- Allocate per-entity during `batch_spawn_splats` (must be bulk copy)
- Change Ward 7's WGSL shader (it already expects flat layout)
- Change Ward 3's `SplatData` (it's already optimal)
- Create new GPU buffers per frame (reuse with dirty flag)
- Assume a fixed `sh_dim` (must support 3, 12, 27, 48 — degree 0-3)

## Must DO

- Eliminate `SplatMaterial` component or reduce it to non-Vec fields
- Move SH coefficients to a flat `Vec<f32>` on `World`, indexed by `entity_index * sh_dim`
- Move opacity to a flat `Vec<f32>` on `World`
- Use `extend_from_slice` or `copy_from_slice` in `batch_spawn_splats` (zero per-entity allocation)
- Create TypeScript GPU buffers for SH and opacity following Ward 5's pattern
- Implement dirty-flag optimization on both buffers
- Verify that the flat buffer indexing matches Ward 7's WGSL `evaluate_sh` access pattern

## Verification

### Green Criteria

1. All 11 tests pass (5 Rust + 6 TypeScript)
2. `SplatMaterial` component is eliminated or reduced to non-Vec fields
3. `World.sh_coefficients` is a flat `Vec<f32>` with length `count * sh_dim`
4. `World.opacities` is a flat `Vec<f32>` with length `count`
5. `batch_spawn_splats` uses bulk copy, not per-entity `.to_vec()`
6. TypeScript GPU buffers exist with correct sizes and dirty-flag behavior
7. Ward 4's existing tests still pass (transform, visibility, entity lifecycle)
8. Buffer indexing matches Ward 7's `sh_coefficients[idx * sh_dim + offset]`

### Deferred Verification

- Render pipeline bind group wiring (SH buffer → binding 4, opacity → binding 3) is integration scope
- Real GPU rendering with SH data is Ward 17 browser test scope
- Wasm → TypeScript memory bridge for SH/opacity is Ward 15 scope

## Relationship to Other Wards

### Ward 3 (upstream, unmodified)
`SplatData` already has contiguous `sh_coefficients` and `opacities`. This Ward consumes them without modification.

### Ward 4 (modified)
`World` struct changes: `materials: ComponentStore<SplatMaterial>` replaced with flat buffers. `batch_spawn_splats` changes from per-entity `.to_vec()` to bulk `extend_from_slice`. Existing Ward 4 tests for transforms and visibility must remain green.

### Ward 5 (pattern source, unmodified)
`GpuSplatBuffer` pattern is replicated for SH and opacity. No changes to Ward 5 code.

### Ward 7 (downstream consumer, unmodified)
The WGSL shader already expects flat `array<f32>` for SH coefficients and opacity. This Ward creates the buffers that will be bound to those shader bindings. The actual bind group wiring is integration scope.

### Ward 15 (downstream)
When FFI exists, the flat `Vec<f32>` in Rust will be exposed as a `WasmMemoryView` directly, enabling zero-copy GPU upload: Rust memory → Float32Array view → writeBuffer → GPU. The TypeScript buffer types defined here will be the upload targets.