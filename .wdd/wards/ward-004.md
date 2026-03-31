---
ward: 4
revision: null
name: "3D ECS Core"
epic: "ecs-webgpu-engine"
status: "planned"
dependencies: [3]
layer: "rust"
estimated_tests: 8
created: "2026-03-31"
completed: null
---
# Ward 004: 3D ECS Core (Porting vcore)

## Scope
Etablering af Entity Component System for 3D-rummet. Porter vcores ComponentStore og "Swap-and-Pop" logik, tilpasset 3D Gaussian Splatting domænet med SoA layout.

## Inputs
- Ward 3: Parsed splat data i SoA layout

## Outputs
- ECS World med entity management
- ComponentStore med Swap-and-Pop
- 3D-specifikke komponenter: Transform, SplatMaterial, Visibility
- Query API til system iteration

## Specification
1. **Entity Manager:**
   - Entity = u32 index + u32 generation (for safe recycling)
   - Spawn/despawn med generation checking
   - Batch spawn for initial PLY load (alle splats på én gang)

2. **ComponentStore (SoA):**
   - Generisk `ComponentStore<T>` med dense array + sparse index
   - Swap-and-Pop removal (O(1) delete, bevarer dense packing)
   - Batch insert fra parsed PLY data (zero-copy hvor muligt)

3. **3D Komponenter:**
   - `Transform`: position (f32x3), rotation (f32x4 quaternion), scale (f32x3)
   - `SplatMaterial`: opacity (f32), SH coefficients (f32xN)
   - `Visibility`: bitflag (visible, selected, deleted)
   - `Deleted`: tag-komponent (ingen data, kun tilstedeværelse)

4. **Query API:**
   - `query<(A, B, C)>()` returnerer iterator over entities med alle specificerede komponenter
   - Support for `With<T>` og `Without<T>` filtre

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | entity_spawn_despawn | Entities kan oprettes og fjernes med korrekt generation |
| 2 | component_store_insert_get | Komponenter kan indsættes og hentes |
| 3 | component_store_swap_and_pop | Removal bevarer dense packing |
| 4 | batch_spawn_from_ply | Bulk insert af splat data er korrekt |
| 5 | transform_component_layout | Transform data er SoA-aligned |
| 6 | visibility_bitflags | Visibility flags kan sættes/cleares korrekt |
| 7 | query_single_component | Query returnerer korrekte entities |
| 8 | query_with_without_filter | With/Without filtre fungerer |

## Must NOT
- Brug tunge objekt-hierarkier — Arrays of Structs (SoA) er et ultimativt krav
- Bruge HashMap til entity lookup (for langsom for millions of entities)
- Allokér per-entity (batch allokering er påkrævet)

## Must DO
- Port vcores ComponentStore og Swap-and-Pop logik
- Opret komponenterne Transform, SplatMaterial og Visibility
- SoA layout for alle komponenter
- Batch spawn API der kan håndtere millioner af entities

## Verification
- Alle 8 tests er grønne
- 5M entities kan spawnes i < 500ms
- Component iteration over 5M entities < 10ms per system
