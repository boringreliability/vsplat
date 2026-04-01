/**
 * GPU Buffer management for splat position data.
 *
 * Creates and uploads GPUBuffers for the low-copy bridge:
 * Wasm memory → Float32Array view → writeBuffer → GPU vRAM.
 */

import type { WasmMemoryView } from "./wasm-memory.js";

export interface GpuSplatBuffer {
  /** The underlying GPUBuffer */
  buffer: GPUBuffer;
  /** Number of splats this buffer holds */
  splatCount: number;
  /**
   * Dirty flag. When true, the next `uploadSplatBuffer` call will
   * write data to the GPU. The flag is automatically reset to false
   * after upload. Newly created buffers start as dirty.
   */
  dirty: boolean;
}

/** Bytes per splat for position data: 3 floats × 4 bytes = 12 */
const BYTES_PER_SPLAT_POSITION = 3 * 4;

/**
 * Create a GPUBuffer sized for `splatCount` splat positions.
 * Usage flags: STORAGE (for shader binding) + COPY_DST (for writeBuffer upload).
 *
 * @throws If splatCount is not a positive integer
 */
export function createGpuSplatBuffer(
  device: GPUDevice,
  splatCount: number,
): GpuSplatBuffer {
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new RangeError(
      `splatCount must be a positive integer, got ${splatCount}`,
    );
  }

  const size = splatCount * BYTES_PER_SPLAT_POSITION;

  const buffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "splat-positions",
  });

  return { buffer, splatCount, dirty: true };
}

/**
 * Upload splat position data from a Wasm memory view to the GPU buffer.
 *
 * **Dirty flag contract:** This function checks `splatBuffer.dirty` internally.
 * If the buffer is not dirty, the call is a no-op (no GPU write occurs).
 * After a successful write, the dirty flag is automatically reset to `false`.
 * Callers should set `splatBuffer.dirty = true` when ECS data changes.
 */
export function uploadSplatBuffer(
  device: GPUDevice,
  splatBuffer: GpuSplatBuffer,
  view: WasmMemoryView,
): void {
  if (!splatBuffer.dirty) {
    return;
  }

  const bufferSize = splatBuffer.splatCount * BYTES_PER_SPLAT_POSITION;
  if (view.byteLength > bufferSize) {
    throw new RangeError(
      `View byteLength (${view.byteLength}) exceeds GPUBuffer size (${bufferSize})`,
    );
  }

  device.queue.writeBuffer(splatBuffer.buffer, 0, view.data);
  splatBuffer.dirty = false;
}
