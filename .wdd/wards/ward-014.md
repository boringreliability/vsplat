---
ward: 14
revision: null
name: "Unified SoA Material Core"
epic: "production-hardening"
status: "planned"
dependencies: [4, 7]
layer: "rust"
estimated_tests: 5
created: "2026-04-01"
completed: null
---
# Ward 014: Unified SoA Material Core

## Scope
Eliminate per-entity Vec<f32> heap allocations for SH coefficients. Replace SplatMaterial's sh_coefficients: Vec<f32> with a single flat contiguous buffer owned by the World. Every splat reads SH data via index arithmetic (idx * sh_dim), not pointer chasing. This is the difference between "demo that works" and "engine that scales".

## Inputs
- Ward 4: ECS World, SplatMaterial component, batch_spawn_splats
- Ward 7: SH evaluation (reads sh_coefficients per splat)

## Outputs
- Flat `Vec<f32>` SH buffer in World (not per-entity)
- SplatMaterial without Vec<f32> (only opacity: f32)
- Index-based SH access: `sh_buffer[entity_index * sh_dim .. + sh_dim]`
- Updated batch_spawn_splats to populate flat buffer
- Documented ownership: World owns SH buffer, render layer reads via slice

## Specification
1. **Remove Vec<f32> from SplatMaterial:** SplatMaterial becomes `{ opacity: f32 }` only. No heap allocation per entity.

2. **World-owned SH buffer:** `World.sh_buffer: Vec<f32>` with length `entity_count * sh_dim`. Contiguous, cache-friendly, GPU-uploadable.

3. **Index arithmetic:** Entity at dense index `i` reads SH from `sh_buffer[i * sh_dim .. (i+1) * sh_dim]`.

4. **batch_spawn_splats update:** Copies SH data from SplatData into the flat buffer during spawn.

5. **Render contract:** Document how the render layer reads SH data for GPU upload.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | splat_material_no_vec | SplatMaterial struct has no Vec<f32> field |
| 2 | sh_buffer_contiguous | World.sh_buffer is one flat Vec, length = count * sh_dim |
| 3 | sh_index_access_correct | Reading sh_buffer[i * sh_dim] returns correct coefficients |
| 4 | batch_spawn_populates_sh_buffer | batch_spawn_splats fills flat SH buffer correctly |
| 5 | sh_buffer_survives_delete | Soft-deleted entity's SH data remains accessible for undo |

## Must NOT
- Allocate Vec<f32> per entity for SH data
- Use HashMap or any per-entity heap structure for material data
- Break existing ECS batch_spawn_splats API contract

## Must DO
- Move SH data to a single flat buffer in World
- Use pure index arithmetic for SH access
- Preserve backward compatibility with existing tests (update, don't delete)
- Document ownership and GPU upload contract

## Verification
- All 5 tests green
- SplatMaterial is a plain struct (no heap pointers)
- SH data is contiguous in memory (verified by address check or layout test)
- Existing Ward 4 tests still pass after refactor
