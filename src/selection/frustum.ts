/**
 * Frustum culling: extract planes from ViewProjection matrix and test points.
 *
 * Uses the Gribb/Hartmann method to extract 6 frustum planes from a
 * Column-Major ViewProjection matrix. Planes are normalised so that
 * signed distance = dot(normal, point) + d.
 *
 * Convention: "inside frustum" = positive side of all 6 planes (dist > 0).
 */

/** 6 frustum planes, each [a, b, c, d] where ax+by+cz+d >= 0 means inside. */
export type FrustumPlanes = [number, number, number, number][];

/**
 * Extract 6 normalised frustum planes from a Column-Major VP matrix.
 *
 * Gribb/Hartmann method: planes are derived from combinations of matrix rows.
 * Order: [left, right, bottom, top, near, far].
 *
 * Each plane is normalised so |normal| = 1, enabling correct distance checks.
 */
export function extractFrustumPlanes(vp: Float32Array): FrustumPlanes {
  // Column-Major: row r of the matrix = vp[r], vp[r+4], vp[r+8], vp[r+12]
  // Row 0: vp[0], vp[4], vp[8],  vp[12]
  // Row 1: vp[1], vp[5], vp[9],  vp[13]
  // Row 2: vp[2], vp[6], vp[10], vp[14]
  // Row 3: vp[3], vp[7], vp[11], vp[15]

  const row = (r: number): [number, number, number, number] => [
    vp[r], vp[r + 4], vp[r + 8], vp[r + 12],
  ];

  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);

  // Gribb/Hartmann: plane = row3 ± rowN
  const rawPlanes: [number, number, number, number][] = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]], // left
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]], // right
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]], // bottom
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]], // top
    [r2[0], r2[1], r2[2], r2[3]],                                    // near (WebGPU Z∈[0,1])
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]], // far
  ];

  // Normalise each plane
  return rawPlanes.map(([a, b, c, d]) => {
    const len = Math.sqrt(a * a + b * b + c * c);
    if (len < 1e-10) return [a, b, c, d] as [number, number, number, number];
    return [a / len, b / len, c / len, d / len] as [number, number, number, number];
  });
}

/**
 * Test if a 3D point is inside all 6 frustum planes.
 * Returns true if signed distance to every plane is > 0 (strictly inside).
 * Points exactly ON a plane (dist == 0) are considered OUTSIDE.
 *
 * Takes x, y, z as individual arguments to avoid allocating a temporary array.
 */
export function isPointInFrustum(
  planes: FrustumPlanes,
  x: number,
  y: number,
  z: number,
): boolean {
  for (const [a, b, c, d] of planes) {
    if (a * x + b * y + c * z + d <= 0) {
      return false;
    }
  }
  return true;
}
