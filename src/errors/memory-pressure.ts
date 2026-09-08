/**
 * Memory pressure estimation for scene loading.
 *
 * Single source of truth for memory estimation formula.
 * Used by checkSceneMemory() to warn before loading.
 */

import { type VsplatError, createVsplatError } from "./vsplat-error.js";

const DEFAULT_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Hvilken slags scene der estimeres for. Ward 026: ét hardkodet tal duede ikke.
 *
 * Et 3DGS-splat og et LiDAR-punkt ligger en faktor ~9 fra hinanden i
 * hukommelsesforbrug. Med splat-tallet for alt afviste gaten 20M punkter længe
 * før GPU'en ville — altså præcis de filer Epic 06 blev bygget til at åbne.
 */
export type SceneFormat = "splats" | "points";

/** LAZ-decoderen (Ward 25) holder de komprimerede bytes i Wasm-memory under
 *  decode. LAZ lander typisk på 10-20 % af den ukomprimerede størrelse; vi
 *  regner konservativt med 20 % af en LAS-record på 36 B. */
const LAZ_RESIDENT_BYTES_PER_POINT = 36 * 0.2;

/**
 * Estimate total memory requirement for loading a scene.
 *
 * Splats (default — Ward 17's adfærd, uændret):
 * - Input bytes (PLY binary: splatCount × ~236 bytes for full SH3 stride)
 * - CPU buffers (SplatData + World flat arrays)
 * - GPU buffers (writeBuffer copies)
 * - 1.5× safety margin
 *
 * Points: input-filen tælles IKKE med — den streames chunk-for-chunk fra OPFS
 * og har aldrig en resident kopi (Ward 16/26). Tilbage er SoA'en
 * (12 B positions + 2 B intensity + 4 B RGBA + 1 B classification = 19 B) plus
 * dens GPU-kopi, og for LAZ de komprimerede bytes decoderen holder.
 */
export function estimateSceneMemory(
  count: number,
  shDim: number,
  format: SceneFormat = "splats",
  compressed = false,
): number {
  if (format === "points") {
    const soaBytes = count * 19;
    const gpuBytes = soaBytes;
    const compressedResident = compressed ? count * LAZ_RESIDENT_BYTES_PER_POINT : 0;
    return Math.ceil((soaBytes + gpuBytes + compressedResident) * 1.5);
  }
  const inputBytes = count * 236; // conservative PLY stride (full SH3)
  const cpuBytes = count * (3 + 4 + 3 + 1 + shDim) * 4;
  const gpuBytes = cpuBytes;
  return Math.ceil((inputBytes + cpuBytes + gpuBytes) * 1.5);
}

/**
 * Check if a scene exceeds the memory threshold.
 *
 * @returns VsplatError with SCENE_TOO_LARGE if over threshold, null if OK.
 */
export function checkSceneMemory(
  count: number,
  shDim: number,
  threshold: number = DEFAULT_THRESHOLD,
  format: SceneFormat = "splats",
  compressed = false,
): VsplatError | null {
  const estimate = estimateSceneMemory(count, shDim, format, compressed);
  if (estimate > threshold) {
    const unit = format === "points" ? "points" : "splats";
    return createVsplatError("SCENE_TOO_LARGE", {
      details: `Estimated ${(estimate / 1e9).toFixed(1)}GB for ${count.toLocaleString()} ${unit} (threshold: ${(threshold / 1e9).toFixed(1)}GB)`,
    });
  }
  return null;
}
