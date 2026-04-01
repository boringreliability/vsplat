/**
 * Wasm Memory View — zero-copy Float32Array access to Wasm linear memory.
 *
 * Creates typed array views directly on the Wasm ArrayBuffer,
 * avoiding any intermediate copies between Rust and JavaScript.
 */

export interface WasmMemoryView {
  /** Float32Array view directly on Wasm memory (no copy) */
  data: Float32Array;
  /** Byte offset into Wasm memory */
  byteOffset: number;
  /** Total byte length of the view */
  byteLength: number;
}

/**
 * Create a Float32Array view into a Wasm memory buffer.
 *
 * @param buffer - The Wasm linear memory ArrayBuffer
 * @param byteOffset - Byte offset where the data starts (must be 4-byte aligned)
 * @param count - Number of f32 elements to view (must be > 0)
 * @throws If byteOffset is not 4-byte aligned, count ≤ 0, or view exceeds buffer bounds
 */
export function createWasmMemoryView(
  buffer: ArrayBuffer,
  byteOffset: number,
  count: number,
): WasmMemoryView {
  if (count <= 0) {
    throw new RangeError(
      `count must be positive, got ${count}`,
    );
  }

  if (byteOffset % 4 !== 0) {
    throw new RangeError(
      `byteOffset must be 4-byte aligned for Float32Array, got ${byteOffset}`,
    );
  }

  const byteLength = count * 4;
  if (byteOffset + byteLength > buffer.byteLength) {
    throw new RangeError(
      `View exceeds buffer bounds: offset ${byteOffset} + ${byteLength} bytes > buffer size ${buffer.byteLength}`,
    );
  }

  const data = new Float32Array(buffer, byteOffset, count);

  return { data, byteOffset, byteLength };
}
