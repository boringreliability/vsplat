---
ward: 13
revision: 2
name: "Generational ECS Safety"
epic: "production-hardening"
status: "complete"
dependencies: [4, 10]
layer: "rust+typescript"
estimated_tests: 11
created: "2026-04-01"
completed: "2026-04-01"
---
# Ward 013: Generational ECS Safety

## Problem Statement

The project has two parallel entity models that do not communicate:

**Rust (Ward 4):** Entities are `{ index: u32, generation: u32 }`. ComponentStore validates generation on every access. Despawned slots get their generation bumped. Stale handles return `None`. This is correct.

**TypeScript (Wards 9-11):** Everything operates on raw `number` or `Uint32Array` array indices. `DeleteCommand` takes `number[]`. `lassoSelect` returns `Uint32Array`. `buildVisibilityMask` iterates by index. `filterSortedIndices` uses raw indices. There is zero generation checking. A stale index silently accesses whatever entity now occupies that slot.

**Current risk level:** Today this is safe because Ward 10 uses soft-delete — no actual despawn, no slot reuse. The corruption vector is dormant. But it is architecturally exposed: the moment real despawn enters the picture (Ward 16+ export compaction, future batch operations, or any feature that reclaims slots), every raw-index path becomes a silent data corruption source. Ward 13 exists to close this gap *before* it becomes acute, not after.

The following sequence illustrates the dormant corruption:

1. User selects splats [5, 12, 30] via lasso (Ward 9)
2. User deletes them (Ward 10 — sets DELETED flag on indices 5, 12, 30)
3. User undoes the delete (Ward 10 — restores flags)
4. If any system reuses slot 5 (future despawn), the restored flags apply to the WRONG entity

## Scope

Add a generation-carrying entity handle type and validation boundaries in the TypeScript command layer. Prevent stale-handle writes from corrupting reused slots. This Ward prepares the TypeScript API surface for Rust-backed generational authority (Ward 15) but does not establish cross-layer entity lifecycle synchronisation.

This Ward does NOT port the full Rust ECS to TypeScript. It adds the minimum safety layer to prevent stale-handle corruption in existing TypeScript code paths.

## Inputs

- Ward 4: Rust `Entity { index: u32, generation: u32 }`, `EntityManager`, `ComponentStore`
- Ward 4: Rust `tests.rs` — entity lifecycle tests (spawn/despawn/reuse/generation bump)
- Ward 9: `lassoSelect` — returns `Uint32Array` of raw indices
- Ward 10: `DeleteCommand` — takes `number[]` of raw indices
- Ward 10: `CommandHistory` — entity-unaware
- Ward 10: `buildVisibilityMask`, `filterSortedIndices` — raw index iteration

## Outputs

- `src/ecs/entity.ts` — TypeScript entity handle type and comparison utilities
- `src/ecs/generation-map.ts` — generation validation helper
- Updated `src/commands/delete.ts` — accepts validated entity handles
- Updated type signatures across command interfaces

## Non-Outputs

- Does NOT rewrite Rust ECS (it's already correct)
- Does NOT add wasm-bindgen FFI (Ward 15 scope)
- Does NOT change the Visibility Uint8Array storage format
- Does NOT change `lassoSelect` return type (hot path, zero-alloc contract)
- Does NOT establish Rust/TypeScript generation synchronisation (Ward 15 scope)

## Specification

### 1. Entity Handle (TypeScript)

```typescript
/** Mirrors Rust Entity { index: u32, generation: u32 } */
export interface EntityHandle {
  readonly index: number;
  readonly generation: number;
}

/** Two handles are equal iff both index AND generation match. */
export function entityEquals(a: EntityHandle, b: EntityHandle): boolean;
```

This is a value type. Cheap to create, compare, and pass around.

### 2. GenerationMap — Validation Helper

A TypeScript-side generation validation helper for command boundary hardening. It tracks generation counters for entity slots and validates handles before write operations.

**Critical framing:** GenerationMap is NOT the authoritative source of truth for entity lifecycle. Rust's EntityManager owns entity lifecycle. GenerationMap is a TypeScript-side validation cache that enables handle checking in TS code paths until Ward 15 bridges it to Rust's authoritative state.

In the current architecture (no wasm-bindgen FFI), GenerationMap maintains its own generation counters for TypeScript-owned test and command flows. When Ward 15 adds the FFI bridge, GenerationMap's backing store will be replaced by a view into Rust's EntityManager memory. The API surface defined here MUST survive that transition unchanged.

```typescript
export class GenerationMap {
  private generations: Uint32Array;

  constructor(maxEntities: number);

  /** Record a spawn. Returns the EntityHandle with current generation. */
  spawn(index: number): EntityHandle;

  /** Batch spawn. Returns EntityHandle[]. */
  batchSpawn(count: number): EntityHandle[];

  /** Record a despawn. Bumps generation for the slot. */
  despawn(handle: EntityHandle): void;

  /** Returns true if index is in range AND generation matches. */
  isAlive(handle: EntityHandle): boolean;

  /** Throws if handle is stale. Error includes expected vs actual generation. */
  validate(handle: EntityHandle): void;

  /** Get current generation for a slot index (for raw-index → handle conversion). */
  generationAt(index: number): number;

  get capacity(): number;
}
```

### 3. Validation Boundaries

**Selection output (Ward 9 → Ward 10):**
`lassoSelect` continues to return `Uint32Array` of raw indices (hot path, zero-alloc). The consumer (`DeleteCommand`) wraps these indices into `EntityHandle[]` by looking up the current generation in `GenerationMap`. This is the raw-index → handle conversion boundary.

**Delete input (Ward 10):**
`DeleteCommand` constructor changes from `(visibility: Uint8Array, selectedIndices: number[])` to `(visibility: Uint8Array, entities: EntityHandle[], generations: GenerationMap)`. On `execute()`, each handle is validated against GenerationMap before modifying visibility flags. Stale handles are skipped (not thrown — the entity is already gone, deletion is a no-op).

**Undo (Ward 10):**
`DeleteCommand.undo()` validates each saved handle before restoring flags. If a handle is stale (slot reused between execute and undo), the undo skips that slot and logs a warning. This prevents the corruption scenario in the Problem Statement.

**Undo semantics consequence:** With generation-safe handles, undo becomes "restore what is still the same entity", not "restore exact previous world state". This is the correct product behavior — restoring flags onto a different entity is worse than skipping a restoration.

**GPU integration (Ward 10):**
`buildVisibilityMask` and `filterSortedIndices` continue to operate on raw indices. They iterate the full visibility array, not selected subsets. No change needed — if the write-side (DeleteCommand) is generation-safe, the read-side stays correct.

### 4. Behavioral Contracts

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| Stale handle on delete execute | Skip silently | Entity already gone — nothing to delete |
| Stale handle on undo | Skip + log warning | Slot reused — restoring old flags would corrupt new entity |
| Stale handle on redo | Skip silently (same as execute) | Re-executing on gone entity is a no-op |
| Handle comparison | Equal iff index AND generation match | `{5, gen:0}` ≠ `{5, gen:1}` |
| GenerationMap vs Rust divergence | Not detectable until Ward 15 | TS validation is best-effort boundary hardening, not cross-layer proof |

## Tests

Tests are in `tests/ward-013/generational-ecs.test.ts`.

Tests are divided into two categories. All tests validate TypeScript-side handle semantics and command safety contracts. They do NOT prove synchronisation correctness with Rust-owned entity lifecycle (deferred to Ward 15).

### Category A: Entity Handle & GenerationMap

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `spawn_returns_generation_zero` | First spawn at index 0 returns `{ index: 0, generation: 0 }`. |
| A2 | `despawn_bumps_generation` | After despawn, same index spawns with `generation: 1`. Old handle fails `isAlive`. |
| A3 | `batch_spawn_sequential` | `batchSpawn(1000)` returns 1000 handles with sequential indices and generation 0. |
| A4 | `validate_throws_on_stale` | `validate()` throws for stale handle. Error message includes expected and actual generation. |
| A5 | `reuse_cycle` | Spawn → despawn → spawn → despawn → spawn at same index. Generations: 0, 1, 2. Only latest is alive. |
| A6 | `handle_equality` | `entityEquals({5, gen:0}, {5, gen:1})` is false. Same index+generation is true. |

### Category B: Generation-Safe Commands

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `delete_skips_stale_handles` | Delete with mix of alive and stale handles. Stale handles skipped, alive handles deleted. No throw. |
| B2 | `undo_skips_reused_slot` | Delete entity at index 5. Despawn and respawn index 5 (new generation). Undo the delete. Index 5 visibility is NOT restored (slot belongs to new entity). |
| B3 | `delete_undo_redo_with_mixed_liveness` | Execute delete on [A, B, C]. Despawn B. Undo: A and C restored, B skipped. Redo: A and C deleted, B still skipped. |
| B4 | `raw_index_to_handle_conversion` | Convert `Uint32Array([3, 7, 12])` from lasso output to `EntityHandle[]` via GenerationMap lookup. Each handle carries current generation. |
| B5 | `stale_handle_does_not_touch_reused_visibility_slot` | Set specific visibility flags on slot. Despawn + respawn slot with different flags. Attempt undo with stale handle. Assert new slot's flags are unchanged bit-for-bit. |

## Must NOT

- Modify Rust ECS code (already generation-safe)
- Add per-entity heap allocations in the hot path
- Break existing `Uint8Array` visibility storage format
- Change `lassoSelect` return type (zero-alloc contract)
- Throw on stale handles in delete/undo (skip instead)
- Present GenerationMap as authoritative source of truth for Rust-owned lifecycle
- Assume generation values are synchronised with Rust (they are not until Ward 15)

## Must DO

- Define `EntityHandle` as a TypeScript value type mirroring Rust's `Entity`
- Implement `GenerationMap` as a validation helper (not lifecycle authority)
- Retrofit `DeleteCommand` to accept `EntityHandle[]` and validate on execute/undo
- Define clear behavioral contracts for stale handles (skip, don't throw)
- Test the corruption scenario: delete → slot reuse → undo → verify no cross-contamination
- Test bit-precise flag preservation on reused slots
- Document that GenerationMap is a validation cache, not authoritative, until Ward 15

## Verification

### Green Criteria

1. All 11 tests pass (6 entity lifecycle + 5 command integration)
2. `src/ecs/entity.ts` and `src/ecs/generation-map.ts` exist with exported types
3. `DeleteCommand` constructor accepts `EntityHandle[]` + `GenerationMap`
4. Stale handles in delete/undo are skipped, not thrown
5. The corruption scenario (delete → slot reuse → undo) is tested and safe
6. Bit-precise flag preservation on reused slots is tested (B5)
7. No raw `number[]` indices cross the command boundary without generation lookup

### What This Ward Does NOT Prove

- Rust/TypeScript generation synchronisation correctness (Ward 15)
- That GenerationMap reflects Rust's EntityManager state (Ward 15)
- Lasso output → EntityHandle conversion under real scene load (Ward 17)
- That GenerationMap is authoritative (it is explicitly NOT — it is a validation helper)

## Relationship to Other Wards

### Ward 4 (upstream)
Rust ECS is already generation-safe. This Ward adds the TypeScript-side mirror of the same concept, not a replacement or competitor.

### Ward 10 (modified)
`DeleteCommand` signature changes. `CommandHistory` is unaffected (stores `Command` interface, agnostic to handle types).

### Ward 9 (upstream, unmodified)
`lassoSelect` return type stays `Uint32Array`. Raw-index → handle conversion happens at the call site, outside the hot path.

### Ward 15 (downstream, critical)
Production Worker Runtime will bridge Rust's `EntityManager` to TypeScript via FFI. At that point, `GenerationMap`'s backing store changes from an independent `Uint32Array` to a view over Rust memory. The API surface designed in this Ward MUST survive that transition unchanged. Ward 15 is the moment where GenerationMap stops being a validation helper and becomes an authoritative Rust-backed view.

### Ward 16+ (downstream)
Any future feature that reclaims entity slots (export compaction, batch despawn) is safe because the handle validation boundary exists.