/**
 * GenerationMap — TypeScript-side generation validation helper.
 *
 * CRITICAL FRAMING: GenerationMap is NOT the authoritative source of truth
 * for entity lifecycle. Rust's EntityManager owns entity lifecycle.
 * GenerationMap is a TypeScript-side validation cache that enables handle
 * checking in TS code paths until Ward 15 bridges it to Rust's authoritative state.
 *
 * When Ward 15 adds the FFI bridge, GenerationMap's backing store will be
 * replaced by a view into Rust's EntityManager memory. The API surface
 * defined here MUST survive that transition unchanged.
 */

import type { EntityHandle } from "./entity.js";

export class GenerationMap {
  private generations: Uint32Array;
  private _capacity: number;

  constructor(maxEntities: number) {
    this._capacity = maxEntities;
    this.generations = new Uint32Array(maxEntities);
  }

  /**
   * Record a spawn at the given index. Returns the EntityHandle with current generation.
   *
   * @throws RangeError if index is out of bounds or not an integer
   */
  spawn(index: number): EntityHandle {
    if (!Number.isInteger(index) || index < 0 || index >= this._capacity) {
      throw new RangeError(
        `Entity index ${index} out of bounds [0, ${this._capacity - 1}]`,
      );
    }
    return { index, generation: this.generations[index] };
  }

  /**
   * Batch spawn count entities, assigning sequential indices starting from 0.
   * Returns EntityHandle[] with current generation for each slot.
   */
  batchSpawn(count: number): EntityHandle[] {
    const handles: EntityHandle[] = [];
    for (let i = 0; i < count; i++) {
      handles.push(this.spawn(i));
    }
    return handles;
  }

  /**
   * Record a despawn. Bumps the generation counter for the slot.
   * Future spawns at this index will have a higher generation.
   */
  despawn(handle: EntityHandle): void {
    if (handle.index < 0 || handle.index >= this._capacity) return;
    if (this.generations[handle.index] !== handle.generation) return; // stale → ignore
    this.generations[handle.index]++;
  }

  /**
   * Returns true if index is in range AND generation matches current.
   * Out-of-range handles return false (not throw).
   */
  isAlive(handle: EntityHandle): boolean {
    if (handle.index < 0 || handle.index >= this._capacity) return false;
    return this.generations[handle.index] === handle.generation;
  }

  /**
   * Throws if handle is stale or out of range.
   * Error message includes expected vs actual generation.
   */
  validate(handle: EntityHandle): void {
    if (handle.index < 0 || handle.index >= this._capacity) {
      throw new RangeError(
        `Entity index ${handle.index} out of bounds [0, ${this._capacity - 1}]`,
      );
    }
    const current = this.generations[handle.index];
    if (current !== handle.generation) {
      throw new Error(
        `Stale entity handle: index ${handle.index} has generation ${current}, ` +
        `but handle has generation ${handle.generation}`,
      );
    }
  }

  /** Get current generation for a slot index (for raw-index → handle conversion). */
  generationAt(index: number): number {
    if (index < 0 || index >= this._capacity) {
      throw new RangeError(`Index ${index} out of bounds [0, ${this._capacity - 1}]`);
    }
    return this.generations[index];
  }

  get capacity(): number {
    return this._capacity;
  }
}
