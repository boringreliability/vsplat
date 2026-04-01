/**
 * GPU integration for visibility: mask generation and sort filtering.
 *
 * buildVisibilityMask: converts Uint8Array flags → Uint32Array (1/0) for GPU upload.
 * filterSortedIndices: removes deleted splats from sorted index array (zero-alloc hot path).
 */

const DELETED = 0x04;

/**
 * Build a GPU-friendly visibility mask from Visibility flags.
 *
 * @param visibility Uint8Array of per-splat Visibility bitflags
 * @returns Uint32Array where 1 = render, 0 = skip (deleted)
 */
export function buildVisibilityMask(visibility: Uint8Array): Uint32Array {
  const mask = new Uint32Array(visibility.length);
  for (let i = 0; i < visibility.length; i++) {
    mask[i] = (visibility[i] & DELETED) ? 0 : 1;
  }
  return mask;
}

/**
 * Filter sorted indices to exclude deleted splats, writing to a pre-allocated buffer.
 *
 * Zero-allocation hot path: writes results to outIndices, returns count.
 * Preserves the sort order from the input.
 *
 * @param sortedIndices Sorted splat indices (from radix sort)
 * @param visibility Uint8Array of per-splat Visibility bitflags
 * @param outIndices Pre-allocated Uint32Array for output. Must be >= sortedIndices.length.
 * @returns Number of non-deleted indices written to outIndices
 * @throws If outIndices is too small
 */
export function filterSortedIndices(
  sortedIndices: Uint32Array,
  visibility: Uint8Array,
  outIndices: Uint32Array,
): number {
  if (outIndices.length < sortedIndices.length) {
    throw new Error(
      `Output buffer too small: need ${sortedIndices.length} slots, got ${outIndices.length}`,
    );
  }

  let count = 0;
  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    if (!(visibility[idx] & DELETED)) {
      outIndices[count++] = idx;
    }
  }
  return count;
}
