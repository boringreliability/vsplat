/**
 * Ward 026 — hvilken render-sti appen kører.
 *
 * Epic 06 pivoterede fra 3D Gaussian Splatting til LiDAR-punktskyer, men
 * `main.ts` pegede stadig på splat-stien. Defaulten flyttes her. Splat-koden
 * (Ward 5-7, 12, 19) bevares som regression-baseline bag `"splats"` — den
 * slettes ikke, den er bare ikke længere det appen starter i.
 */

import type { RenderMode } from "../webgpu/point-pipeline.js";

export const DEFAULT_RENDER_MODE: RenderMode = "points";

/** Hvilken pipeline en render-mode vælger. */
export type PipelineKind = "colored-point" | "splat";

export function pipelineForRenderMode(mode: RenderMode): PipelineKind {
  return mode === "splats" ? "splat" : "colored-point";
}
