/**
 * Memory pressure estimation for scene loading.
 *
 * Single source of truth for memory estimation formula.
 * Used by checkSceneMemory() to warn before loading.
 */

import { type VsplatError, createVsplatError } from "./vsplat-error.js";

const DEFAULT_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Estimate total memory requirement for loading a scene.
 *
 * Accounts for:
 * - Input bytes (PLY binary: splatCount × ~236 bytes for full SH3 stride)
 * - CPU buffers (SplatData + World flat arrays)
 * - GPU buffers (writeBuffer copies)
 * - 1.5× safety margin
 */
export function estimateSceneMemory(splatCount: number, shDim: number): number {
  const inputBytes = splatCount * 236; // conservative PLY stride (full SH3)
  const cpuBytes = splatCount * (3 + 4 + 3 + 1 + shDim) * 4;
  const gpuBytes = cpuBytes;
  return Math.ceil((inputBytes + cpuBytes + gpuBytes) * 1.5);
}

/**
 * Check if a scene exceeds the memory threshold.
 *
 * @returns VsplatError with SCENE_TOO_LARGE if over threshold, null if OK.
 */
export function checkSceneMemory(
  splatCount: number,
  shDim: number,
  threshold: number = DEFAULT_THRESHOLD,
): VsplatError | null {
  const estimate = estimateSceneMemory(splatCount, shDim);
  if (estimate > threshold) {
    return createVsplatError("SCENE_TOO_LARGE", {
      details: `Estimated ${(estimate / 1e9).toFixed(1)}GB for ${splatCount.toLocaleString()} splats (threshold: ${(threshold / 1e9).toFixed(1)}GB)`,
    });
  }
  return null;
}
