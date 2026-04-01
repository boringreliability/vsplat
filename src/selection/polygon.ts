/**
 * Point-in-polygon test using on-segment check + ray-casting algorithm.
 *
 * Strict boundary contract: All points exactly on an edge or vertex are
 * considered OUTSIDE (false). This avoids double-counting at shared edges.
 *
 * Algorithm:
 *   1. Bounding box early-exit (precomputed or inline)
 *   2. On-segment check: if point lies on ANY edge, return false immediately
 *   3. Ray-casting: cast horizontal ray toward +X, count edge crossings.
 *      Odd = inside, even = outside.
 *
 * Zero-allocation: no arrays or objects created inside the function.
 */

/**
 * Check if point (px, py) lies on the line segment from (ax, ay) to (bx, by).
 * Uses cross-product for collinearity and bounding box for containment.
 */
function isOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): boolean {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > 1e-10) return false;

  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);

  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/**
 * Test if point (px, py) is strictly inside a polygon.
 *
 * Public API — computes bounding box inline. For hot loops where the same
 * polygon is tested against many points, use `pointInPolygonWithBBox` with
 * a precomputed bounding box to avoid redundant iteration.
 */
export function pointInPolygon(
  px: number,
  py: number,
  polygon: [number, number][],
): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  // Compute bounding box inline
  let bbMinX = polygon[0][0];
  let bbMaxX = bbMinX;
  let bbMinY = polygon[0][1];
  let bbMaxY = bbMinY;
  for (let i = 1; i < n; i++) {
    const vx = polygon[i][0];
    const vy = polygon[i][1];
    if (vx < bbMinX) bbMinX = vx;
    if (vx > bbMaxX) bbMaxX = vx;
    if (vy < bbMinY) bbMinY = vy;
    if (vy > bbMaxY) bbMaxY = vy;
  }

  return pointInPolygonWithBBox(px, py, polygon, bbMinX, bbMinY, bbMaxX, bbMaxY);
}

/**
 * Test if point (px, py) is strictly inside a polygon, with precomputed bounding box.
 *
 * Designed for hot loops: caller computes BBox once, passes it to every call.
 * Zero-allocation.
 */
export function pointInPolygonWithBBox(
  px: number,
  py: number,
  polygon: [number, number][],
  bbMinX: number,
  bbMinY: number,
  bbMaxX: number,
  bbMaxY: number,
): boolean {
  // Step 1: BBox early-exit
  if (px < bbMinX || px > bbMaxX || py < bbMinY || py > bbMaxY) {
    return false;
  }

  const n = polygon.length;

  // Step 2: On-segment check — if point is on ANY edge, return false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (isOnSegment(px, py, polygon[i][0], polygon[i][1], polygon[j][0], polygon[j][1])) {
      return false;
    }
  }

  // Step 3: Ray-casting (point is guaranteed NOT on any edge)
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = polygon[i][1];
    const yj = polygon[j][1];

    if ((yi >= py) !== (yj >= py)) {
      const xIntersect = polygon[j][0] + ((py - yj) / (yi - yj)) * (polygon[i][0] - polygon[j][0]);
      if (px < xIntersect) {
        inside = !inside;
      }
    }
  }

  return inside;
}
