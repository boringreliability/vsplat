/**
 * GPU buffer for Spherical Harmonics coefficients.
 *
 * Flat contiguous buffer: splatCount * shDim * 4 bytes.
 * Indexed as sh_coefficients[splat_index * sh_dim + coeff_index].
 * Matches Ward 7 WGSL: @group(0) @binding(4) var<storage, read> sh_coefficients: array<f32>;
 *
 * Follows Ward 5's dirty-flag pattern.
 */

export interface GpuSHBuffer {
  buffer: GPUBuffer;
  splatCount: number;
  shDim: number;
  dirty: boolean;
}

/**
 * Create a GPU storage buffer for SH coefficients.
 *
 * @throws RangeError if splatCount is not a positive integer
 */
export function createGpuSHBuffer(
  device: GPUDevice,
  splatCount: number,
  shDim: number,
): GpuSHBuffer {
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new RangeError(`splatCount must be a positive integer, got ${splatCount}`);
  }

  const size = splatCount * shDim * 4;
  const buffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sh-coefficients",
  });

  return { buffer, splatCount, shDim, dirty: true };
}

/**
 * Upload SH coefficient data to GPU buffer.
 *
 * Dirty-flag contract: skips upload if not dirty. Resets dirty to false after write.
 *
 * @throws If data length does not match splatCount * shDim
 */
export function uploadSHBuffer(
  device: GPUDevice,
  shBuffer: GpuSHBuffer,
  data: Float32Array,
): void {
  const expected = shBuffer.splatCount * shBuffer.shDim;
  if (data.length !== expected) {
    throw new RangeError(
      `SH data length mismatch: expected ${expected}, got ${data.length}`,
    );
  }

  if (!shBuffer.dirty) return;

  device.queue.writeBuffer(shBuffer.buffer, 0, data);
  shBuffer.dirty = false;
}
