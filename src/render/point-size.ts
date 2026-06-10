/**
 * Ward 023 — CPU-side reference for perspektiv-korrekt point size.
 *
 * Matches WGSL impl: `clamp(base_size_px / clip_w * density_factor, 1.0, max_size_px)`.
 * Returns size in pixels. Caller converts to clip-space via `size_px / viewport_px * 2`.
 */

export interface PointSizeParams {
  baseSizePx: number;
  maxSizePx: number;
  densityFactor: number;
  viewportPx: number;
}

export function computePointSize(clipW: number, params: PointSizeParams): number {
  const raw = (params.baseSizePx / clipW) * params.densityFactor;
  return Math.max(1.0, Math.min(params.maxSizePx, raw));
}
