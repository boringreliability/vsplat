/**
 * CPU reference implementation of radix sort for splat depth ordering.
 *
 * Used for testing correctness and as a fallback. The GPU compute shader
 * (radix-sort-gpu.ts) implements the same algorithm in WGSL.
 */

// Shared buffer for float↔uint bit reinterpretation (no allocation per call)
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/**
 * Reinterpret a float as a sortable unsigned integer.
 *
 * IEEE 754 floats don't sort correctly as raw bits (negatives are reversed).
 * This transformation makes them sort correctly as unsigned integers:
 * - If sign bit set: flip ALL bits (reverses negative ordering)
 * - If sign bit clear: flip ONLY sign bit (shifts positives above negatives)
 *
 * Result: the uint ordering matches the float ordering for all finite values.
 */
export function floatToSortableUint(f: number): number {
  _f32[0] = f;
  const bits = _u32[0];
  if (bits & 0x80000000) {
    return (bits ^ 0xFFFFFFFF) >>> 0;
  }
  return (bits ^ 0x80000000) >>> 0;
}

/**
 * Compute sort keys (depths) for each splat based on camera position and view direction.
 *
 * sortKey = dot(viewDir, position - cameraPos)
 * Larger sortKey = farther from camera = rendered first (back-to-front).
 *
 * @returns sortKeys (Float32Array) and identity indices (Uint32Array)
 */
export function computeDepths(
  positions: Float32Array,
  cameraPos: [number, number, number],
  viewDir: [number, number, number],
): { sortKeys: Float32Array; indices: Uint32Array } {
  const count = positions.length / 3;
  const sortKeys = new Float32Array(count);
  const indices = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * 3;
    const dx = positions[base] - cameraPos[0];
    const dy = positions[base + 1] - cameraPos[1];
    const dz = positions[base + 2] - cameraPos[2];
    sortKeys[i] = dx * viewDir[0] + dy * viewDir[1] + dz * viewDir[2];
    indices[i] = i;
  }

  return { sortKeys, indices };
}

/**
 * Stable LSD Radix Sort on float sort keys, descending (farthest first).
 *
 * Sorts indices by their corresponding sortKeys using 8-bit radix (4 passes).
 * Descending order is achieved by sorting the bitwise-inverted sortable keys.
 * LSD (Least Significant Digit first) guarantees stability.
 *
 * @param sortKeys - Float32 depths for each element
 * @param indices - Initial index array (modified in-place via ping-pong)
 * @returns Sorted index array (back-to-front: largest sortKey first)
 */
export function radixSortIndices(
  sortKeys: Float32Array,
  indices: Uint32Array,
): Uint32Array {
  const n = indices.length;
  if (n <= 1) return indices;

  // Convert floats to sortable uints, then invert for descending order
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] = (~floatToSortableUint(sortKeys[indices[i]])) >>> 0;
  }

  const RADIX_BITS = 8;
  const BUCKET_COUNT = 1 << RADIX_BITS; // 256
  const MASK = BUCKET_COUNT - 1;

  // Ping-pong buffers
  let srcKeys = keys;
  let srcIdx = indices;
  let dstKeys = new Uint32Array(n);
  let dstIdx = new Uint32Array(n);

  const counts = new Uint32Array(BUCKET_COUNT);

  // 4 passes for 32-bit keys (8 bits per pass)
  for (let pass = 0; pass < 4; pass++) {
    const shift = pass * RADIX_BITS;

    // Count occurrences of each digit
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const digit = (srcKeys[i] >>> shift) & MASK;
      counts[digit]++;
    }

    // Prefix sum (exclusive) — gives starting index for each bucket
    let total = 0;
    for (let i = 0; i < BUCKET_COUNT; i++) {
      const c = counts[i];
      counts[i] = total;
      total += c;
    }

    // Scatter to destination (stable: left-to-right preserves order within each bucket)
    for (let i = 0; i < n; i++) {
      const digit = (srcKeys[i] >>> shift) & MASK;
      const pos = counts[digit]++;
      dstKeys[pos] = srcKeys[i];
      dstIdx[pos] = srcIdx[i];
    }

    // Swap buffers
    [srcKeys, dstKeys] = [dstKeys, srcKeys];
    [srcIdx, dstIdx] = [dstIdx, srcIdx];
  }

  return srcIdx;
}
