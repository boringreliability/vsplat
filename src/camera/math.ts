/**
 * Camera math: perspective projection and lookAt view matrix.
 *
 * All matrices are Column-Major Float32Array(16) — WebGPU/WGSL standard.
 * WebGPU clip space Z ∈ [0, 1] (not [-1, 1] like OpenGL).
 */

/**
 * Create a perspective projection matrix for WebGPU (Z ∈ [0, 1]).
 *
 * Column-Major layout. Maps view-space to clip-space with:
 *   x_clip = x_view * f / aspect
 *   y_clip = y_view * f
 *   z_clip ∈ [0, 1] (WebGPU, not OpenGL's [-1, 1])
 *
 * @throws RangeError if parameters are invalid
 */
export function perspectiveMatrix(
  fov: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  if (fov <= 0 || fov >= Math.PI) {
    throw new RangeError(`fov must be in (0, π), got ${fov}`);
  }
  if (aspect <= 0) {
    throw new RangeError(`aspect must be positive, got ${aspect}`);
  }
  if (near <= 0) {
    throw new RangeError(`near must be positive, got ${near}`);
  }
  if (far <= near) {
    throw new RangeError(`far must be greater than near, got far=${far}, near=${near}`);
  }

  const f = 1.0 / Math.tan(fov / 2);
  const nf = near - far;

  // Column-Major: mat[col * 4 + row]
  const out = new Float32Array(16);
  out[0]  = f / aspect; // col 0, row 0
  out[5]  = f;          // col 1, row 1
  out[10] = far / nf;   // col 2, row 2  (WebGPU Z mapping)
  out[11] = -1;         // col 2, row 3  (perspective divide)
  out[14] = (near * far) / nf; // col 3, row 2
  // All other elements are 0 (Float32Array is zero-initialized)
  return out;
}

/**
 * Create a lookAt view matrix (right-handed, Column-Major).
 *
 * Builds an orthonormal basis:
 *   View-space +Z axis = normalize(eye - target)  (points away from target)
 *   Right              = normalize(cross(up, +Z axis))
 *   Up'                = cross(+Z axis, Right)
 *
 * Objects in front of the camera land on negative Z in view space.
 *
 * Translation column = [-dot(R, eye), -dot(U, eye), -dot(Zaxis, eye)]
 */
export function lookAtMatrix(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): Float32Array {
  // View-space +Z axis = normalize(eye - target)
  // Points away from target — objects in front have negative Z.
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLen = Math.sqrt(zx * zx + zy * zy + zz * zz);
  zx /= zLen; zy /= zLen; zz /= zLen;

  // Right = normalize(cross(up, +Z axis))
  let rx = up[1] * zz - up[2] * zy;
  let ry = up[2] * zx - up[0] * zz;
  let rz = up[0] * zy - up[1] * zx;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rLen; ry /= rLen; rz /= rLen;

  // Up' = cross(+Z axis, Right)
  const ux = zy * rz - zz * ry;
  const uy = zz * rx - zx * rz;
  const uz = zx * ry - zy * rx;

  // Column-Major: mat[col * 4 + row]
  const out = new Float32Array(16);
  // Column 0: right
  out[0] = rx; out[1] = ux; out[2] = zx; out[3] = 0;
  // Column 1: up
  out[4] = ry; out[5] = uy; out[6] = zy; out[7] = 0;
  // Column 2: view-space +Z axis
  out[8] = rz; out[9] = uz; out[10] = zz; out[11] = 0;
  // Column 3: translation = -dot(basis, eye)
  out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;

  return out;
}

/**
 * Column-Major 4x4 matrix-produkt: returnerer `a · b`.
 *
 * Ward 026: point-stien skal bygge en view-projection ud af
 * `perspectiveMatrix` og `lookAtMatrix`. Indeksering er `m[col * 4 + row]`,
 * som resten af projektet.
 */
export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
