/**
 * Ward 013 — Generational ECS Safety Tests
 *
 * Category A: Entity Handle & GenerationMap (6 tests)
 *   Verify TypeScript-side entity handle semantics: spawn, despawn, generation
 *   bumping, validation, reuse cycles, and equality.
 *
 * Category B: Generation-Safe Commands (5 tests)
 *   Verify that DeleteCommand validates handles against GenerationMap,
 *   skips stale handles on execute/undo/redo, and prevents cross-contamination
 *   when slots are reused between operations.
 *
 * GenerationMap is a TypeScript-side validation cache, NOT the authoritative
 * source of truth for entity lifecycle. Rust's EntityManager owns lifecycle.
 * This Ward prepares the API surface for Ward 15 (Rust FFI bridge).
 *
 * Behavioral contract:
 *   - Stale handle on delete execute → skip silently
 *   - Stale handle on undo → skip (slot reused, restoring old flags would corrupt)
 *   - Stale handle on redo → skip silently (same as execute)
 */

import { describe, it, expect } from "vitest";
import {
  type EntityHandle,
  entityEquals,
} from "../../src/ecs/entity.js";
import {
  GenerationMap,
} from "../../src/ecs/generation-map.js";
import {
  DeleteCommand,
} from "../../src/commands/delete.js";

// ─── Shared Constants ────────────────────────────────────────────

const VISIBLE = 0x01;
const DELETED = 0x04;

// ─── Category A: Entity Handle & GenerationMap ───────────────────

describe("Ward 013: Generational ECS Safety", () => {

  describe("Category A: Entity Handle & GenerationMap", () => {

    // ─── A1: spawn_returns_generation_zero ─────────────────────────

    it("A1: first spawn returns { index: 0, generation: 0 }", () => {
      const map = new GenerationMap(100);

      const handle = map.spawn(0);

      expect(handle.index).toBe(0);
      expect(handle.generation).toBe(0);
    });

    // ─── A2: despawn_bumps_generation ──────────────────────────────

    it("A2: after despawn, same index spawns with generation 1; old handle fails isAlive", () => {
      const map = new GenerationMap(100);

      const h0 = map.spawn(0);
      expect(map.isAlive(h0)).toBe(true);

      map.despawn(h0);
      expect(map.isAlive(h0)).toBe(false);

      const h1 = map.spawn(0); // reuse slot 0
      expect(h1.index).toBe(0);
      expect(h1.generation).toBe(1);
      expect(map.isAlive(h1)).toBe(true);

      // Old handle is still stale
      expect(map.isAlive(h0)).toBe(false);
    });

    // ─── A3: batch_spawn_sequential ────────────────────────────────

    it("A3: batchSpawn(1000) returns 1000 unique, alive, generation-0 handles", () => {
      const map = new GenerationMap(2000);

      const handles = map.batchSpawn(1000);

      expect(handles.length).toBe(1000);

      // All alive with generation 0
      for (const h of handles) {
        expect(h.generation).toBe(0);
        expect(map.isAlive(h)).toBe(true);
      }

      // All indices are unique
      const indices = new Set(handles.map(h => h.index));
      expect(indices.size).toBe(1000);
    });

    // ─── A4: validate_throws_on_stale ──────────────────────────────

    it("A4: validate() throws for stale handle with expected vs actual generation", () => {
      const map = new GenerationMap(100);

      const h0 = map.spawn(0);
      map.despawn(h0);
      map.spawn(0); // generation now 1

      expect(() => map.validate(h0)).toThrow();

      // Error message should include generation info
      try {
        map.validate(h0);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("0"); // expected generation
        expect(msg).toContain("1"); // actual generation
      }
    });

    // ─── A5: reuse_cycle ───────────────────────────────────────────

    it("A5: spawn→despawn→spawn×3 at same index produces generations 0, 1, 2", () => {
      const map = new GenerationMap(100);

      const h0 = map.spawn(5);
      expect(h0.generation).toBe(0);

      map.despawn(h0);
      const h1 = map.spawn(5);
      expect(h1.generation).toBe(1);

      map.despawn(h1);
      const h2 = map.spawn(5);
      expect(h2.generation).toBe(2);

      // Only latest is alive
      expect(map.isAlive(h0)).toBe(false);
      expect(map.isAlive(h1)).toBe(false);
      expect(map.isAlive(h2)).toBe(true);
    });

    // ─── A6: handle_equality ───────────────────────────────────────

    it("A6: entityEquals compares both index AND generation", () => {
      const a: EntityHandle = { index: 5, generation: 0 };
      const b: EntityHandle = { index: 5, generation: 1 };
      const c: EntityHandle = { index: 5, generation: 0 };
      const d: EntityHandle = { index: 6, generation: 0 };

      expect(entityEquals(a, b)).toBe(false);
      expect(entityEquals(a, c)).toBe(true);
      expect(entityEquals(a, d)).toBe(false);
    });

    // ─── A7: out_of_range_validation ─────────────────────────────

    it("A7: spawn/isAlive/validate reject out-of-range indices", () => {
      const map = new GenerationMap(10);

      // Spawn beyond capacity
      expect(() => map.spawn(10)).toThrow();
      expect(() => map.spawn(-1)).toThrow();
      expect(() => map.spawn(1.5)).toThrow();

      // isAlive with out-of-range handle returns false (not throw)
      expect(map.isAlive({ index: 999, generation: 0 })).toBe(false);
      expect(map.isAlive({ index: -1, generation: 0 })).toBe(false);

      // validate with out-of-range handle throws
      expect(() => map.validate({ index: 999, generation: 0 })).toThrow();
    });

    // ─── A8: stale_handle_cannot_despawn_live_entity ───────────────

    it("A8: stale handle cannot despawn a live entity", () => {
      const map = new GenerationMap(100);
      const h0 = map.spawn(5);        // gen 0
      map.despawn(h0);                  // gen → 1
      const h1 = map.spawn(5);         // gen 1, alive

      // Stale h0 tries to despawn — must be ignored
      map.despawn(h0);                  // h0.generation(0) ≠ current(1) → no-op

      // h1 is still alive, generation unchanged
      expect(map.isAlive(h1)).toBe(true);
      expect(map.generationAt(5)).toBe(1);
    });
  });

  // ─── Category B: Generation-Safe Commands ──────────────────────

  describe("Category B: Generation-Safe Commands", () => {

    // ─── B1: delete_skips_stale_handles ────────────────────────────

    it("B1: delete with mix of alive and stale handles skips stale, deletes alive", () => {
      const map = new GenerationMap(100);
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE]);

      const h0 = map.spawn(0);
      const h1 = map.spawn(1);
      const h2 = map.spawn(2);

      // Despawn h1 → stale
      map.despawn(h1);
      map.spawn(1); // new entity at slot 1, generation 1

      // Delete with mix: h0 (alive), h1 (stale, gen 0), h2 (alive)
      const cmd = new DeleteCommand(visibility, [h0, h1, h2], map);
      cmd.execute();

      // h0 and h2 deleted
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[2] & DELETED).toBeTruthy();

      // h1 was stale → slot 1 untouched (belongs to new entity)
      expect(visibility[1]).toBe(VISIBLE);
    });

    // ─── B2: undo_skips_reused_slot ────────────────────────────────

    it("B2: undo skips restoration when slot has been reused (new generation)", () => {
      const map = new GenerationMap(100);
      const visibility = new Uint8Array([VISIBLE, VISIBLE]);

      const h0 = map.spawn(0);
      map.spawn(1);

      // Delete entity at index 0
      const cmd = new DeleteCommand(visibility, [h0], map);
      cmd.execute();
      expect(visibility[0] & DELETED).toBeTruthy();

      // Now despawn and respawn index 0 with new generation
      map.despawn(h0);
      const h0New = map.spawn(0);
      // New entity gets VISIBLE
      visibility[0] = VISIBLE;

      // Undo the delete — h0 is stale, slot now belongs to h0New
      cmd.undo();

      // Index 0 visibility must NOT be restored to old state (would corrupt new entity)
      expect(visibility[0]).toBe(VISIBLE); // unchanged — undo skipped
    });

    // ─── B3: delete_undo_redo_with_mixed_liveness ──────────────────

    it("B3: execute→despawn B→undo→redo: A and C toggle, B always skipped", () => {
      const map = new GenerationMap(100);
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE]);

      const hA = map.spawn(0);
      const hB = map.spawn(1);
      const hC = map.spawn(2);

      const cmd = new DeleteCommand(visibility, [hA, hB, hC], map);

      // Execute: all three deleted
      cmd.execute();
      expect(visibility[0] & DELETED).toBeTruthy(); // A
      expect(visibility[1] & DELETED).toBeTruthy(); // B
      expect(visibility[2] & DELETED).toBeTruthy(); // C

      // Despawn B and respawn (new generation)
      map.despawn(hB);
      map.spawn(1);
      visibility[1] = VISIBLE; // new entity is visible

      // Undo: A and C restored, B skipped (stale)
      cmd.undo();
      expect(visibility[0] & VISIBLE).toBeTruthy();
      expect(visibility[0] & DELETED).toBeFalsy();
      expect(visibility[1]).toBe(VISIBLE); // B untouched
      expect(visibility[2] & VISIBLE).toBeTruthy();
      expect(visibility[2] & DELETED).toBeFalsy();

      // Redo: A and C deleted again, B still skipped
      cmd.execute();
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[1]).toBe(VISIBLE); // B still untouched
      expect(visibility[2] & DELETED).toBeTruthy();
    });

    // ─── B4: raw_index_to_handle_conversion ────────────────────────

    it("B4: convert Uint32Array lasso output to EntityHandle[] via GenerationMap", () => {
      const map = new GenerationMap(100);
      map.batchSpawn(20); // spawn indices 0-19

      // Lasso output: raw indices from Ward 9
      const rawIndices = new Uint32Array([3, 7, 12]);

      // Convert to handles via generation lookup
      const handles: EntityHandle[] = [];
      for (let i = 0; i < rawIndices.length; i++) {
        const idx = rawIndices[i];
        handles.push({ index: idx, generation: map.generationAt(idx) });
      }

      expect(handles.length).toBe(3);
      expect(handles[0]).toEqual({ index: 3, generation: 0 });
      expect(handles[1]).toEqual({ index: 7, generation: 0 });
      expect(handles[2]).toEqual({ index: 12, generation: 0 });

      // Each handle is alive
      for (const h of handles) {
        expect(map.isAlive(h)).toBe(true);
      }
    });

    // ─── B5: stale_handle_does_not_touch_reused_visibility_slot ────

    it("B5: stale undo preserves new entity's visibility flags bit-for-bit", () => {
      const map = new GenerationMap(100);
      const FUTURE_FLAG = 0x08;

      // Original entity at slot 3 with VISIBLE
      const visibility = new Uint8Array(10).fill(VISIBLE);
      const h3 = map.spawn(3);

      // Delete entity at slot 3
      const cmd = new DeleteCommand(visibility, [h3], map);
      cmd.execute();
      expect(visibility[3] & DELETED).toBeTruthy();

      // Despawn and respawn slot 3 with new generation
      map.despawn(h3);
      map.spawn(3);

      // New entity has custom flags: VISIBLE + FUTURE_FLAG
      visibility[3] = VISIBLE | FUTURE_FLAG;

      // Undo delete with stale handle — must NOT touch slot 3
      cmd.undo();

      // New entity's flags are preserved bit-for-bit
      expect(visibility[3]).toBe(VISIBLE | FUTURE_FLAG);
      expect(visibility[3] & VISIBLE).toBeTruthy();
      expect(visibility[3] & FUTURE_FLAG).toBeTruthy();
      expect(visibility[3] & DELETED).toBeFalsy();
    });
  });
});
