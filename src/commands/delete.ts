/**
 * DeleteCommand: soft-delete selected splats via Visibility bitflags.
 *
 * Sets DELETED flag and clears VISIBLE flag on selected entities.
 * Preserves ALL other flags (e.g. SELECTED, future flags) via bitwise ops.
 * Data remains in ECS arrays — no Swap-and-Pop. Undo restores original flags.
 *
 * Handles duplicate indices: stores original flags per unique index.
 *
 * STATEFUL: The `savedFlags` Map is populated on first execute() and reused
 * across undo/redo cycles. This ensures idempotent flag restoration even when
 * the same command is re-executed via redo().
 *
 * Generation-safe (Ward 13): When constructed with EntityHandle[] + GenerationMap,
 * stale handles are skipped on execute and undo. This prevents cross-contamination
 * when entity slots are reused between operations.
 *
 * Behavioral contract:
 *   - Stale handle on execute → skip silently (entity already gone)
 *   - Stale handle on undo → skip (slot reused, restoring old flags would corrupt)
 */

import type { Command } from "./history.js";
import type { EntityHandle } from "../ecs/entity.js";
import type { GenerationMap } from "../ecs/generation-map.js";

const VISIBLE = 0x01;
const DELETED = 0x04;

export class DeleteCommand implements Command {
  private visibility: Uint8Array;
  /** Map from unique index → original flag value before execute */
  private savedFlags: Map<number, number>;
  private handles: EntityHandle[];
  private generations: GenerationMap | null;

  /**
   * @param visibility Per-splat visibility flags
   * @param entities EntityHandle[] with generation info, OR number[] for legacy (Ward 10) compat
   * @param generations GenerationMap for validation, or undefined for legacy mode
   */
  constructor(
    visibility: Uint8Array,
    entities: EntityHandle[] | number[],
    generations?: GenerationMap,
  ) {
    // Normalize: number[] → EntityHandle[] (legacy Ward 10 compat)
    if (entities.length > 0 && typeof entities[0] === "number") {
      const indices = entities as number[];
      for (const idx of indices) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= visibility.length) {
          throw new RangeError(`Index ${idx} out of bounds [0, ${visibility.length - 1}]`);
        }
      }
      this.handles = indices.map(idx => ({ index: idx, generation: 0 }));
      this.generations = null;
    } else {
      this.handles = entities as EntityHandle[];
      this.generations = generations ?? null;
    }

    this.visibility = visibility;
    this.savedFlags = new Map();
  }

  execute(): void {
    for (const handle of this.handles) {
      const idx = handle.index;

      // Generation-safe: skip stale handles (entity already gone)
      if (this.generations && !this.generations.isAlive(handle)) {
        continue;
      }

      // Save original flags only once per unique index (idempotent for duplicates)
      if (!this.savedFlags.has(idx)) {
        this.savedFlags.set(idx, this.visibility[idx]);
      }
      // Clear VISIBLE, set DELETED, preserve everything else
      this.visibility[idx] = (this.visibility[idx] & ~VISIBLE) | DELETED;
    }
  }

  undo(): void {
    // Restore original flags for each affected index.
    // Generation-safe: skip if slot has been reused (new entity).
    for (const [idx, original] of this.savedFlags) {
      if (this.generations) {
        // Find the handle that originally targeted this index
        const handle = this.handles.find(h => h.index === idx);
        if (handle && !this.generations.isAlive(handle)) {
          // Slot reused — restoring old flags would corrupt new entity. Skip.
          continue;
        }
      }
      this.visibility[idx] = original;
    }
  }
}
