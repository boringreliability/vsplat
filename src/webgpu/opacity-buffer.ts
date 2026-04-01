/**
 * GPU buffer for per-splat opacity values.
 *
 * Flat contiguous buffer: splatCount * 4 bytes.
 * Indexed as opacities[splat_index].
 * Matches Ward 7 WGSL: @group(0) @binding(3) var<storage, read> opacities: array<f32>;
 *
 * Follows Ward 5's dirty-flag pattern.
 */

export interface GpuOpacityBuffer {
  buffer: GPUBuffer;
  splatCount: number;
  dirty: boolean;
}

/**
 * Create a GPU storage buffer for opacity values.
 *
 * @throws RangeError if splatCount is not a positive integer
 */
export function createGpuOpacityBuffer(
  device: GPUDevice,
  splatCount: number,
): GpuOpacityBuffer {
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new RangeError(`splatCount must be a positive integer, got ${splatCount}`);
  }

  const size = splatCount * 4;
  const buffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "opacity",
  });

  return { buffer, splatCount, dirty: true };
}

/**
 * Upload opacity data to GPU buffer.
 *
 * Dirty-flag contract: skips upload if not dirty. Resets dirty to false after write.
 *
 * @throws If data length does not match splatCount
 */
export function uploadOpacityBuffer(
  device: GPUDevice,
  opacityBuffer: GpuOpacityBuffer,
  data: Float32Array,
): void {
  if (data.length !== opacityBuffer.splatCount) {
    throw new RangeError(
      `Opacity data length mismatch: expected ${opacityBuffer.splatCount}, got ${data.length}`,
    );
  }

  if (!opacityBuffer.dirty) return;

  device.queue.writeBuffer(opacityBuffer.buffer, 0, data);
  opacityBuffer.dirty = false;
}
