/**
 * TypeScript entity handle type mirroring Rust's Entity { index: u32, generation: u32 }.
 *
 * EntityHandle is a value type — cheap to create, compare, and pass around.
 * Two handles are equal iff both index AND generation match.
 */

/** Mirrors Rust Entity { index: u32, generation: u32 } */
export interface EntityHandle {
  readonly index: number;
  readonly generation: number;
}

/** Two handles are equal iff both index AND generation match. */
export function entityEquals(a: EntityHandle, b: EntityHandle): boolean {
  return a.index === b.index && a.generation === b.generation;
}
