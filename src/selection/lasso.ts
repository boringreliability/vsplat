/**
 * Lasso selection: project 3D splats to screen and test against a 2D polygon.
 *
 * Pipeline: frustum cull → project to screen → point-in-polygon test.
 * Zero-allocation hot path: no arrays or objects are created inside the selection loop.
 * Screen projection results are written to module-scoped scratch variables.
 */

import { extractFrustumPlanes, isPointInFrustum } from "./frustum.js";
import { pointInPolygonWithBBox } from "./polygon.js";

// Module-scoped scratch space for screen projection (zero allocation in hot path)
let _screenX = 0;
let _screenY = 0;

/**
 * Project a 3D world-space point to 2D screen coordinates (internal, zero-alloc).
 *
 * Writes result to module-scoped _screenX, _screenY.
 * @returns true if projection succeeded, false if behind camera (w <= 0)
 */
function _projectInternal(
  vp: Float32Array,
  x: number,
  y: number,
  z: number,
  viewportW: number,
  viewportH: number,
): boolean {
  // VP * [x, y, z, 1] (Column-Major)
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];

  if (cw <= 0) return false;

  const ndcX = cx / cw;
  const ndcY = cy / cw;

  // NDC to screen pixels (Y-flipped: WebGPU pixel space has (0,0) at top-left)
  _screenX = (ndcX * 0.5 + 0.5) * viewportW;
  _screenY = (0.5 - ndcY * 0.5) * viewportH;

  return true;
}

/**
 * Project a 3D world-space point to 2D screen coordinates.
 *
 * Public API that returns a tuple (allocates). Use for single-point queries
 * outside of hot loops. The hot loop in lassoSelect uses _projectInternal.
 *
 * @returns [screenX, screenY] or null if behind camera (w <= 0)
 */
export function projectToScreen(
  vp: Float32Array,
  point: [number, number, number],
  viewport: [number, number],
): [number, number] | null {
  if (!_projectInternal(vp, point[0], point[1], point[2], viewport[0], viewport[1])) {
    return null;
  }
  return [_screenX, _screenY];
}

/**
 * Select splats inside a 2D lasso polygon, writing to a pre-allocated output buffer.
 *
 * Zero-allocation hot path: no temporary arrays or objects are created per splat.
 * Pipeline per splat:
 *   1. Frustum cull (individual x, y, z — no array allocation)
 *   2. Project to screen (writes to module-scoped scratch variables)
 *   3. Point-in-polygon test against lasso
 *   4. Write index to outIndices
 *
 * @param positions Float32Array of [x0,y0,z0, x1,y1,z1, ...] splat positions
 * @param vp Column-Major ViewProjection matrix
 * @param viewport [width, height] in pixels
 * @param lasso 2D polygon vertices [[x,y], ...] in screen pixels
 * @param outIndices Pre-allocated Uint32Array to receive selected splat indices.
 *   Must be at least as large as the number of splats (positions.length / 3).
 * @returns Number of selected splats (written to outIndices[0..count-1])
 * @throws If outIndices is too small
 */
export function lassoSelect(
  positions: Float32Array,
  vp: Float32Array,
  viewport: [number, number],
  lasso: [number, number][],
  outIndices: Uint32Array,
): number {
  const count = positions.length / 3;

  if (outIndices.length < count) {
    throw new Error(
      `Output buffer too small: need ${count} slots, got ${outIndices.length}`,
    );
  }

  const planes = extractFrustumPlanes(vp);
  const vpW = viewport[0];
  const vpH = viewport[1];

  // Precompute lasso polygon bounding box once (not per-splat)
  let bbMinX = lasso[0][0];
  let bbMaxX = bbMinX;
  let bbMinY = lasso[0][1];
  let bbMaxY = bbMinY;
  for (let k = 1; k < lasso.length; k++) {
    const lx = lasso[k][0];
    const ly = lasso[k][1];
    if (lx < bbMinX) bbMinX = lx;
    if (lx > bbMaxX) bbMaxX = lx;
    if (ly < bbMinY) bbMinY = ly;
    if (ly > bbMaxY) bbMaxY = ly;
  }

  let selected = 0;

  for (let i = 0; i < count; i++) {
    const base = i * 3;
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];

    // Step 1: frustum cull (no array allocation)
    if (!isPointInFrustum(planes, x, y, z)) {
      continue;
    }

    // Step 2: project to screen (writes to _screenX, _screenY — no allocation)
    if (!_projectInternal(vp, x, y, z, vpW, vpH)) {
      continue;
    }

    // Step 3: point-in-polygon with precomputed BBox (reads _screenX, _screenY directly)
    if (pointInPolygonWithBBox(_screenX, _screenY, lasso, bbMinX, bbMinY, bbMaxX, bbMaxY)) {
      outIndices[selected++] = i;
    }
  }

  return selected;
}
