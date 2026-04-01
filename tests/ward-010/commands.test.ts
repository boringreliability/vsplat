/**
 * Ward 010 — Command System & Editor Actions Tests
 *
 * Tests the Command pattern (execute/undo/redo), CommandHistory stack management,
 * soft-delete via Visibility bitflags, GPU visibility mask generation, and
 * sort-filtering of deleted splats.
 *
 * Soft-delete contract: DeleteCommand sets the DELETED bitflag in Visibility.
 * Data remains in ECS arrays — no Swap-and-Pop. Undo simply clears the flag.
 * Real removal happens only at export (Ward 11).
 */

import { describe, it, expect } from "vitest";
import {
  CommandHistory,
  type Command,
} from "../../src/commands/history.js";
import {
  DeleteCommand,
} from "../../src/commands/delete.js";
import {
  buildVisibilityMask,
  filterSortedIndices,
} from "../../src/commands/gpu-integration.js";

// ─── Shared Constants (matching Ward 4 Visibility bitflags) ──────

const VISIBLE = 0x01;
const SELECTED = 0x02;
const DELETED = 0x04;

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 010: Command System & Editor Actions", () => {

  // ─── Test 1: command_execute_undo ─────────────────────────────

  describe("Command execute and undo", () => {
    it("should execute a command and reverse it with undo", () => {
      let value = 0;
      const cmd: Command = {
        execute() { value += 10; },
        undo() { value -= 10; },
      };

      const history = new CommandHistory();

      history.execute(cmd);
      expect(value).toBe(10);

      history.undo();
      expect(value).toBe(0);

      // Undo when empty is a no-op
      history.undo();
      expect(value).toBe(0);
    });
  });

  // ─── Test 2: command_redo ─────────────────────────────────────

  describe("Command redo", () => {
    it("should redo an undone command", () => {
      let value = 0;
      const cmd: Command = {
        execute() { value += 5; },
        undo() { value -= 5; },
      };

      const history = new CommandHistory();
      history.execute(cmd);
      expect(value).toBe(5);

      history.undo();
      expect(value).toBe(0);

      history.redo();
      expect(value).toBe(5);

      // Redo when empty is a no-op
      history.redo();
      expect(value).toBe(5);
    });
  });

  // ─── Test 3: delete_adds_tag ──────────────────────────────────

  describe("DeleteCommand", () => {
    it("should set DELETED flag without removing data from arrays", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE, VISIBLE, VISIBLE]);
      const selectedIndices = [1, 3];

      const cmd = new DeleteCommand(visibility, selectedIndices);
      cmd.execute();

      // Selected splats: DELETED set, VISIBLE cleared
      expect(visibility[1] & DELETED).toBeTruthy();
      expect(visibility[3] & DELETED).toBeTruthy();
      expect(visibility[1] & VISIBLE).toBeFalsy();
      expect(visibility[3] & VISIBLE).toBeFalsy();

      // Non-selected splats untouched
      expect(visibility[0]).toBe(VISIBLE);
      expect(visibility[2]).toBe(VISIBLE);
      expect(visibility[4]).toBe(VISIBLE);

      // Array length unchanged — no data removed
      expect(visibility.length).toBe(5);
    });
  });

  // ─── Test 3b: delete_preserves_unrelated_flags ────────────────

  describe("DeleteCommand flag preservation", () => {
    it("should preserve unrelated flags during execute and undo", () => {
      // Given: a splat with VISIBLE + a hypothetical future flag 0x08
      const FUTURE_FLAG = 0x08;
      const visibility = new Uint8Array([VISIBLE | FUTURE_FLAG, VISIBLE]);
      const selectedIndices = [0];

      const cmd = new DeleteCommand(visibility, selectedIndices);

      // When: execute
      cmd.execute();

      // Then: VISIBLE cleared, DELETED set, but FUTURE_FLAG preserved
      expect(visibility[0] & VISIBLE).toBeFalsy();
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[0] & FUTURE_FLAG).toBeTruthy(); // preserved!

      // When: undo
      cmd.undo();

      // Then: DELETED cleared, VISIBLE restored, FUTURE_FLAG still preserved
      expect(visibility[0] & VISIBLE).toBeTruthy();
      expect(visibility[0] & DELETED).toBeFalsy();
      expect(visibility[0] & FUTURE_FLAG).toBeTruthy(); // still preserved!
    });
  });

  // ─── Test 3c: delete_with_duplicate_indices_is_idempotent ─────

  describe("DeleteCommand idempotency", () => {
    it("should handle duplicate indices without side effects on undo", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE]);
      // Duplicate index 1 three times
      const selectedIndices = [1, 1, 1];

      const cmd = new DeleteCommand(visibility, selectedIndices);

      cmd.execute();
      expect(visibility[1] & DELETED).toBeTruthy();
      expect(visibility[1] & VISIBLE).toBeFalsy();

      // Undo should restore cleanly despite duplicates
      cmd.undo();
      expect(visibility[1] & DELETED).toBeFalsy();
      expect(visibility[1] & VISIBLE).toBeTruthy();

      // Other splats untouched throughout
      expect(visibility[0]).toBe(VISIBLE);
      expect(visibility[2]).toBe(VISIBLE);
    });
  });

  // ─── Test 3d: delete_execute_undo_redo_sequence ─────────────────

  describe("DeleteCommand full undo/redo cycle", () => {
    it("should correctly toggle flags through execute→undo→redo", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE]);
      const cmd = new DeleteCommand(visibility, [0]);
      const history = new CommandHistory();

      // Execute: splat 0 deleted
      history.execute(cmd);
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[0] & VISIBLE).toBeFalsy();
      expect(visibility[1]).toBe(VISIBLE); // untouched

      // Undo: splat 0 restored
      history.undo();
      expect(visibility[0] & DELETED).toBeFalsy();
      expect(visibility[0] & VISIBLE).toBeTruthy();

      // Redo: splat 0 deleted again (same command re-executed)
      history.redo();
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[0] & VISIBLE).toBeFalsy();

      // Undo again: back to original
      history.undo();
      expect(visibility[0] & DELETED).toBeFalsy();
      expect(visibility[0] & VISIBLE).toBeTruthy();
    });
  });

  // ─── Test 4: undo_delete_removes_tag ──────────────────────────

  describe("Undo DeleteCommand", () => {
    it("should restore VISIBLE flag and clear DELETED on undo (bit-precise)", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE]);
      const selectedIndices = [0, 2];

      const cmd = new DeleteCommand(visibility, selectedIndices);

      cmd.execute();
      expect(visibility[0] & DELETED).toBeTruthy();
      expect(visibility[2] & DELETED).toBeTruthy();

      cmd.undo();

      // Bit-precise checks (not .toBe(VISIBLE) which would miss extra flags)
      expect(visibility[0] & DELETED).toBeFalsy();
      expect(visibility[0] & VISIBLE).toBeTruthy();
      expect(visibility[2] & DELETED).toBeFalsy();
      expect(visibility[2] & VISIBLE).toBeTruthy();

      // Middle splat was never touched
      expect(visibility[1]).toBe(VISIBLE);
    });
  });

  // ─── Test 5: deleted_splats_not_rendered ───────────────────────

  describe("GPU visibility mask", () => {
    it("should produce a mask where deleted splats are 0 and visible are 1", () => {
      const visibility = new Uint8Array([VISIBLE, DELETED, VISIBLE, DELETED, VISIBLE]);

      const mask = buildVisibilityMask(visibility);

      expect(mask).toBeInstanceOf(Uint32Array);
      expect(mask.length).toBe(5);
      expect(mask[0]).toBe(1);
      expect(mask[1]).toBe(0);
      expect(mask[2]).toBe(1);
      expect(mask[3]).toBe(0);
      expect(mask[4]).toBe(1);
    });
  });

  // ─── Test 6: deleted_splats_not_sorted ────────────────────────

  describe("Sort filtering", () => {
    it("should exclude deleted splats from sorted index output (zero-alloc)", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE, DELETED, VISIBLE, DELETED, VISIBLE]);
      const sortedAll = new Uint32Array([5, 3, 1, 0, 4, 2]);

      // Pre-allocated output buffer — filterSortedIndices writes to THIS buffer,
      // not a new one. The returned count tells us how many entries are valid.
      const outIndices = new Uint32Array(6);
      const count = filterSortedIndices(sortedAll, visibility, outIndices);

      expect(count).toBe(4);
      const result = Array.from(outIndices.subarray(0, count));
      expect(result).toEqual([5, 3, 1, 0]);
    });

    it("should throw if output buffer is too small", () => {
      const visibility = new Uint8Array([VISIBLE, VISIBLE, VISIBLE]);
      const sortedAll = new Uint32Array([2, 1, 0]);

      // Output buffer has only 2 slots but 3 visible splats
      const tooSmall = new Uint32Array(2);
      expect(() => filterSortedIndices(sortedAll, visibility, tooSmall))
        .toThrow();
    });
  });

  // ─── Test 7: command_history_limit ────────────────────────────

  describe("CommandHistory max depth", () => {
    it("should drop oldest commands when exceeding max depth", () => {
      const values: number[] = [];
      const history = new CommandHistory(3);

      for (let i = 0; i < 5; i++) {
        const val = i;
        history.execute({
          execute() { values.push(val); },
          undo() { values.pop(); },
        });
      }

      expect(values).toEqual([0, 1, 2, 3, 4]);

      history.undo(); // removes 4
      history.undo(); // removes 3
      history.undo(); // removes 2
      expect(values).toEqual([0, 1]);

      // 4th undo is a no-op (oldest commands were dropped)
      history.undo();
      expect(values).toEqual([0, 1]);
    });
  });

  // ─── Test 8: redo_cleared_on_new_command ───────────────────────

  describe("Redo cleared on new command", () => {
    it("should clear redo stack when a new command is executed", () => {
      let value = 0;
      const history = new CommandHistory();

      history.execute({
        execute() { value = 10; },
        undo() { value = 0; },
      });
      expect(value).toBe(10);

      history.undo();
      expect(value).toBe(0);

      expect(history.canRedo()).toBe(true);

      history.execute({
        execute() { value = 99; },
        undo() { value = 0; },
      });
      expect(value).toBe(99);

      expect(history.canRedo()).toBe(false);
      history.redo();
      expect(value).toBe(99);
    });
  });
});
