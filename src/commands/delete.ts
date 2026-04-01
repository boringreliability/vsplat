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
 */

import type { Command } from "./history.js";

const VISIBLE = 0x01;
const DELETED = 0x04;

export class DeleteCommand implements Command {
  private visibility: Uint8Array;
  /** Map from unique index → original flag value before execute */
  private savedFlags: Map<number, number>;
  private indices: number[];

  constructor(visibility: Uint8Array, selectedIndices: number[]) {
    // Validate all indices are in bounds and are integers
    for (const idx of selectedIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= visibility.length) {
        throw new RangeError(
          `Index ${idx} out of bounds [0, ${visibility.length - 1}]`,
        );
      }
    }

    this.visibility = visibility;
    this.indices = selectedIndices;
    this.savedFlags = new Map();
  }

  execute(): void {
    for (const idx of this.indices) {
      // Save original flags only once per unique index (idempotent for duplicates)
      if (!this.savedFlags.has(idx)) {
        this.savedFlags.set(idx, this.visibility[idx]);
      }
      // Clear VISIBLE, set DELETED, preserve everything else
      this.visibility[idx] = (this.visibility[idx] & ~VISIBLE) | DELETED;
    }
  }

  undo(): void {
    // Restore exact original flags for each affected index
    for (const [idx, original] of this.savedFlags) {
      this.visibility[idx] = original;
    }
  }
}
