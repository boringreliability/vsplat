/**
 * Ward 023 — CPU-side AABB-vs-frustum cull for batched draws.
 *
 * Plane-AABB-test: for hver plane, find AABB's "positive vertex" (det hjørne
 * længst i plane-normal-retning) og test om det er bag planet. Hvis ALLE planes
 * har den positive vertex bag sig, er hele AABB udenfor frustum og kan culles.
 *
 * Plane-format: `[a, b, c, d]` hvor `a*x + b*y + c*z + d >= 0` er "indenfor".
 * Ward 9's `extractFrustumPlanes` returnerer planes i denne form.
 */

import type { BoundingBox } from "./batch-manager.js";

/** Returns true if AABB is completely outside the frustum (skip draw). */
export function cullBatch(aabb: BoundingBox, planes: Float32Array): boolean {
  const planeCount = planes.length / 4;
  for (let i = 0; i < planeCount; i++) {
    const a = planes[i * 4 + 0]!;
    const b = planes[i * 4 + 1]!;
    const c = planes[i * 4 + 2]!;
    const d = planes[i * 4 + 3]!;
    // Positive vertex: corner that maximizes (a*x + b*y + c*z)
    const px = a >= 0 ? aabb.max[0] : aabb.min[0];
    const py = b >= 0 ? aabb.max[1] : aabb.min[1];
    const pz = c >= 0 ? aabb.max[2] : aabb.min[2];
    const dist = a * px + b * py + c * pz + d;
    if (dist < 0) {
      // Hele AABB ligger på den negative side af denne plane → cull
      return true;
    }
  }
  return false;
}
