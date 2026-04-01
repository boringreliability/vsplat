---
ward: 13
revision: null
name: "Generational ECS Safety"
epic: "production-hardening"
status: "planned"
dependencies: [4]
layer: "rust"
estimated_tests: 6
created: "2026-04-01"
completed: null
---
# Ward 013: Generational ECS Safety

## Scope
Make ECS generation-safe end-to-end. ComponentStore must never return components for stale entity handles. A despawned entity whose slot is reused must be invisible to old references. This prevents "generational ghosts" — the most insidious class of ECS bugs.

## Inputs
- Ward 4: EntityManager (generation bumping), ComponentStore (sparse→dense)

## Outputs
- Generation-validated get/remove/iter on ComponentStore
- Stale handle rejection tests (insert with old generation, get after reuse)
- Batch spawn/despawn/reuse stress tests

## Specification
1. **ComponentStore generation check:** `get(entity)` must compare entity.generation against the generation stored in the sparse array. If mismatch → return None (not stale data).

2. **Insert with stale handle:** `insert(staleEntity, data)` must reject or overwrite safely. The slot may now belong to a different entity.

3. **Iter safety:** Iteration must only yield entities whose generation matches. A stale entry in sparse must not leak through.

4. **Batch stress:** Spawn 1000 → despawn 500 → respawn 500 → verify no stale leaks.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | get_rejects_stale_handle | get() returns None for despawned+reused entity handle |
| 2 | insert_stale_handle_rejected | insert() with old generation does not corrupt new entity |
| 3 | remove_stale_handle_noop | remove() with stale handle is a safe no-op |
| 4 | iter_skips_stale_entries | Iteration only yields current-generation entities |
| 5 | batch_spawn_despawn_reuse | 1000→500 despawn→500 respawn, no stale data |
| 6 | generation_overflow_handling | Generation wraps or errors at u32::MAX |

## Must NOT
- Return data for a despawned entity through any API path
- Allow stale handles to corrupt data belonging to new entities
- Silently succeed on stale operations (must be no-op or error)

## Must DO
- Store generation alongside entity index in ComponentStore sparse array
- Validate generation on every get/remove operation
- Test the full lifecycle: spawn → use → despawn → reuse slot → verify isolation

## Verification
- All 6 tests green
- No stale data accessible through any ComponentStore API
- Batch stress test with 1000+ entities passes without leaks
