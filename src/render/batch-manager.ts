/**
 * Ward 023 — k-d tree spatial subdivision for batched draw calls.
 *
 * Implementation: rekursiv median-split på longest axis. Hver split flytter
 * points i en ny Float32Array så batchen kan repræsenteres som en
 * sammenhængende `[firstPoint, firstPoint+pointCount)` slice.
 */

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface Batch {
  firstPoint: number;
  pointCount: number;
  aabb: BoundingBox;
}

export interface SubdivisionResult {
  positions: Float32Array;
  batches: Batch[];
  /** Permutation: `originalIndex = permutation[reorderedIndex]`. Use to re-order parallel attribute arrays. */
  permutation: Uint32Array;
}

const MAX_DEPTH = 6; // 2^6 = 64 max leaves

function computeAabb(positions: Float32Array, indices: Uint32Array): BoundingBox {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i]! * 3;
    const x = positions[p]!, y = positions[p + 1]!, z = positions[p + 2]!;
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
}

function longestAxis(aabb: BoundingBox): 0 | 1 | 2 {
  const dx = aabb.max[0] - aabb.min[0];
  const dy = aabb.max[1] - aabb.min[1];
  const dz = aabb.max[2] - aabb.min[2];
  if (dx >= dy && dx >= dz) return 0;
  if (dy >= dz) return 1;
  return 2;
}

interface LeafInfo {
  indices: Uint32Array;
  aabb: BoundingBox;
}

function subdivideRecursive(
  positions: Float32Array,
  indices: Uint32Array,
  depth: number,
  maxPerBatch: number,
  out: LeafInfo[],
): void {
  if (indices.length === 0) return;
  const aabb = computeAabb(positions, indices);
  if (indices.length <= maxPerBatch || depth >= MAX_DEPTH) {
    out.push({ indices, aabb });
    return;
  }
  const axis = longestAxis(aabb);
  // Median split via sort. For very large batches this is O(N log N) per level,
  // but with max 6 levels and typical batch sizes (~1M) it's a one-time cost
  // dwarfed by parse + GPU upload.
  const sorted = new Uint32Array(indices);
  sorted.sort((a, b) => positions[a * 3 + axis]! - positions[b * 3 + axis]!);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted.slice(0, mid);
  const right = sorted.slice(mid);
  subdivideRecursive(positions, left, depth + 1, maxPerBatch, out);
  subdivideRecursive(positions, right, depth + 1, maxPerBatch, out);
}

export class BatchManager {
  static subdivide(positions: Float32Array, maxPerBatch = 250_000): SubdivisionResult {
    const pointCount = positions.length / 3;
    if (pointCount === 0) {
      return { positions: new Float32Array(0), batches: [], permutation: new Uint32Array(0) };
    }
    const indices = new Uint32Array(pointCount);
    for (let i = 0; i < pointCount; i++) indices[i] = i;

    const leaves: LeafInfo[] = [];
    subdivideRecursive(positions, indices, 0, maxPerBatch, leaves);

    // Re-pack positions in batch-order so each batch is a contiguous slice
    const reordered = new Float32Array(positions.length);
    const permutation = new Uint32Array(pointCount);
    const batches: Batch[] = [];
    let cursor = 0;
    for (const leaf of leaves) {
      const firstPoint = cursor;
      for (let i = 0; i < leaf.indices.length; i++) {
        const originalIdx = leaf.indices[i]!;
        const src = originalIdx * 3;
        const dst = cursor * 3;
        reordered[dst + 0] = positions[src + 0]!;
        reordered[dst + 1] = positions[src + 1]!;
        reordered[dst + 2] = positions[src + 2]!;
        permutation[cursor] = originalIdx;
        cursor++;
      }
      batches.push({
        firstPoint,
        pointCount: leaf.indices.length,
        aabb: leaf.aabb,
      });
    }
    return { positions: reordered, batches, permutation };
  }
}

/**
 * Anvend `SubdivisionResult.permutation` på en parallel attribut-array.
 *
 * `subdivide` pakker positions om, så intensity/rgb/classification SKAL følge
 * med — ellers får hvert punkt en anden farve end sin egen. `stride` er antal
 * elementer per punkt (1 for intensity/classification, 4 for RGBA).
 */
export function permuteAttribute<T extends Uint8Array | Uint16Array | Uint32Array | Float32Array>(
  src: T,
  permutation: Uint32Array,
  stride: number,
): T {
  const out = new (src.constructor as new (len: number) => T)(permutation.length * stride);
  for (let i = 0; i < permutation.length; i++) {
    const from = permutation[i]! * stride;
    const to = i * stride;
    for (let k = 0; k < stride; k++) out[to + k] = src[from + k]!;
  }
  return out;
}
