/**
 * Ward 023 — CPU-side reference for perspektiv-korrekt point size.
 *
 * Matcher WGSL'ens `clamp(base_size_px / clip_w, 1.0, max_size_px)` i
 * `colored-point-pipeline.ts`. Returnerer pixels; kalderen konverterer til
 * clip-space via `size_px / viewport_px * 2`.
 *
 * `density_factor` indgår bevidst IKKE i størrelsen. Spec'ens §5 lader den
 * styre hvor mange punkter der droppes (`hash(idx) > density_factor`), og
 * shaderen gør netop det. Hvis den også skrumpede de overlevende punkter,
 * ville throttling åbne huller dobbelt så hurtigt — man vil have de
 * tilbageværende punkter mindst lige så store, ikke mindre. Feltet bliver
 * derfor i `PointSizeParams`, fordi det spejler shaderens uniform, men det
 * påvirker ikke størrelsen.
 */

export interface PointSizeParams {
  baseSizePx: number;
  maxSizePx: number;
  /** Uploades til shaderens uniform og styrer point-dropping — ikke størrelsen. */
  densityFactor: number;
  viewportPx: number;
}

export function computePointSize(clipW: number, params: PointSizeParams): number {
  const raw = params.baseSizePx / Math.max(clipW, 1e-6);
  return Math.max(1.0, Math.min(params.maxSizePx, raw));
}
