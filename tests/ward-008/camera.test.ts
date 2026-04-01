/**
 * Ward 008 — 3D Camera Math & Controllers Tests
 *
 * Tests perspective projection, lookAt view matrix, orbit controls
 * (rotate/zoom/pan), fly controls (WASD), and matrix upload pipeline.
 *
 * All matrices use Column-Major layout (WebGPU standard).
 * WebGPU clip space Z ∈ [0, 1] (not [-1, 1] like OpenGL).
 * Angles are in Radians. Yaw follows Right-Handed Rule (CCW = positive from top).
 */

import { describe, it, expect, vi } from "vitest";
import {
  perspectiveMatrix,
  lookAtMatrix,
} from "../../src/camera/math.js";
import {
  OrbitController,
} from "../../src/camera/orbit.js";
import {
  FlyController,
} from "../../src/camera/fly.js";
import {
  CameraSystem,
} from "../../src/camera/system.js";

// ─── WebGPU Stubs ────────────────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  UNIFORM: 0x0040,
  COPY_DST: 0x0008,
});

function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => ({
      size: desc.size, usage: desc.usage, label: desc.label ?? "",
    })),
    queue: {
      writeBuffer: vi.fn(),
    },
  } as unknown as GPUDevice;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Extract element at row r, col c from Column-Major 4×4 matrix */
function m(mat: Float32Array, row: number, col: number): number {
  return mat[col * 4 + row];
}

/**
 * Multiply a Column-Major 4×4 matrix by a vec4, returning [x, y, z, w].
 * M * v = sum over columns: M_col_j * v_j
 */
function mulMat4Vec4(
  mat: Float32Array,
  v: [number, number, number, number],
): [number, number, number, number] {
  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      result[row] += mat[col * 4 + row] * v[col];
    }
  }
  return result;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 008: 3D Camera Math & Controllers", () => {

  // ─── Test 1: perspective_matrix_correct ────────────────────────

  describe("perspectiveMatrix", () => {
    it("should produce a correct WebGPU perspective matrix (Z ∈ [0,1])", () => {
      // Given: standard parameters
      const fov = Math.PI / 4; // 45°
      const aspect = 16 / 9;
      const near = 0.1;
      const far = 1000;

      // When: we compute the perspective matrix
      const P = perspectiveMatrix(fov, aspect, near, far);

      // Then: it's a 16-element Float32Array (4×4 Column-Major)
      expect(P).toBeInstanceOf(Float32Array);
      expect(P.length).toBe(16);

      // P[0][0] = 1 / (aspect * tan(fov/2))
      const tanHalf = Math.tan(fov / 2);
      expect(m(P, 0, 0)).toBeCloseTo(1 / (aspect * tanHalf), 4);

      // P[1][1] = 1 / tan(fov/2)
      expect(m(P, 1, 1)).toBeCloseTo(1 / tanHalf, 4);

      // WebGPU Z mapping: [0, 1] not [-1, 1]
      // P[2][2] = far / (near - far)
      expect(m(P, 2, 2)).toBeCloseTo(far / (near - far), 4);

      // P[3][2] = -1 (perspective divide)
      expect(m(P, 3, 2)).toBeCloseTo(-1, 4);

      // P[2][3] = near * far / (near - far)
      expect(m(P, 2, 3)).toBeCloseTo((near * far) / (near - far), 4);

      // Off-diagonal elements should be 0
      expect(m(P, 0, 1)).toBeCloseTo(0, 4);
      expect(m(P, 1, 0)).toBeCloseTo(0, 4);
      expect(m(P, 3, 3)).toBeCloseTo(0, 4);
    });

    it("should throw RangeError on invalid parameters", () => {
      expect(() => perspectiveMatrix(0, 16 / 9, 0.1, 1000)).toThrow(RangeError);         // fov = 0
      expect(() => perspectiveMatrix(Math.PI, 16 / 9, 0.1, 1000)).toThrow(RangeError);   // fov = π
      expect(() => perspectiveMatrix(-0.5, 16 / 9, 0.1, 1000)).toThrow(RangeError);      // fov < 0
      expect(() => perspectiveMatrix(Math.PI / 4, 0, 0.1, 1000)).toThrow(RangeError);    // aspect = 0
      expect(() => perspectiveMatrix(Math.PI / 4, -1, 0.1, 1000)).toThrow(RangeError);   // aspect < 0
      expect(() => perspectiveMatrix(Math.PI / 4, 16 / 9, -1, 1000)).toThrow(RangeError);// near < 0
      expect(() => perspectiveMatrix(Math.PI / 4, 16 / 9, 0, 1000)).toThrow(RangeError); // near = 0
      expect(() => perspectiveMatrix(Math.PI / 4, 16 / 9, 10, 5)).toThrow(RangeError);   // far < near
      expect(() => perspectiveMatrix(Math.PI / 4, 16 / 9, 10, 10)).toThrow(RangeError);  // far = near
    });
  });

  // ─── Test 2: lookat_matrix_correct ────────────────────────────

  describe("lookAtMatrix", () => {
    it("should transform eye to view-space origin and target to -Z axis", () => {
      // Given: camera at (0, 0, 5) looking at origin, Y-up
      const eye: [number, number, number] = [0, 0, 5];
      const target: [number, number, number] = [0, 0, 0];
      const up: [number, number, number] = [0, 1, 0];

      // When: we compute the lookAt matrix
      const V = lookAtMatrix(eye, target, up);

      expect(V).toBeInstanceOf(Float32Array);
      expect(V.length).toBe(16);

      // Then: V * eye = (0, 0, 0, 1) — camera is at origin in view space
      const eyeInView = mulMat4Vec4(V, [eye[0], eye[1], eye[2], 1]);
      expect(eyeInView[0]).toBeCloseTo(0, 3);
      expect(eyeInView[1]).toBeCloseTo(0, 3);
      expect(eyeInView[2]).toBeCloseTo(0, 3);
      expect(eyeInView[3]).toBeCloseTo(1, 3);

      // Then: V * target has X=0, Y=0, and negative Z (target is in front of camera)
      const targetInView = mulMat4Vec4(V, [target[0], target[1], target[2], 1]);
      expect(targetInView[0]).toBeCloseTo(0, 3);
      expect(targetInView[1]).toBeCloseTo(0, 3);
      expect(targetInView[2]).toBeLessThan(0); // in front = negative Z

      // Verify with an off-axis camera too
      const eye2: [number, number, number] = [3, 4, 5];
      const V2 = lookAtMatrix(eye2, target, up);
      const eye2InView = mulMat4Vec4(V2, [eye2[0], eye2[1], eye2[2], 1]);
      expect(eye2InView[0]).toBeCloseTo(0, 3);
      expect(eye2InView[1]).toBeCloseTo(0, 3);
      expect(eye2InView[2]).toBeCloseTo(0, 3);
      const target2InView = mulMat4Vec4(V2, [target[0], target[1], target[2], 1]);
      expect(target2InView[2]).toBeLessThan(0);
    });
  });

  // ─── Test 3: orbit_rotate ─────────────────────────────────────

  describe("OrbitController rotate", () => {
    it("should rotate camera around target preserving distance", () => {
      // Given: orbit controller with camera at (0, 0, 5) looking at origin
      const orbit = new OrbitController({
        target: [0, 0, 0],
        distance: 5,
        azimuth: 0,     // radians
        elevation: 0,   // radians
      });

      const posBefore = orbit.getPosition();
      expect(posBefore[2]).toBeCloseTo(5); // on Z-axis

      // When: we rotate +π/2 azimuth (radians, CCW from top = Right-Handed Rule)
      orbit.rotate(Math.PI / 2, 0);
      const posAfter = orbit.getPosition();

      // Then: camera moved from Z-axis to X-axis (at distance 5)
      expect(posAfter[0]).toBeCloseTo(5, 1);
      expect(Math.abs(posAfter[2])).toBeLessThan(0.1);

      // Distance to target is preserved
      const dist = Math.sqrt(posAfter[0] ** 2 + posAfter[1] ** 2 + posAfter[2] ** 2);
      expect(dist).toBeCloseTo(5, 2);
    });
  });

  // ─── Test 4: orbit_zoom ───────────────────────────────────────

  describe("OrbitController zoom", () => {
    it("should change distance to target on scroll", () => {
      const orbit = new OrbitController({
        target: [0, 0, 0],
        distance: 10,
        azimuth: 0,
        elevation: 0,
      });

      expect(orbit.getDistance()).toBeCloseTo(10);

      // When: we zoom in (negative delta = scroll toward)
      orbit.zoom(-3);
      expect(orbit.getDistance()).toBeCloseTo(7);

      // When: we zoom out
      orbit.zoom(5);
      expect(orbit.getDistance()).toBeCloseTo(12);

      // Distance should be clamped to minimum (never <= 0)
      orbit.zoom(-100);
      expect(orbit.getDistance()).toBeGreaterThan(0);
    });
  });

  // ─── Test 5: orbit_pan ────────────────────────────────────────

  describe("OrbitController pan", () => {
    it("should translate target and position by the same delta", () => {
      const orbit = new OrbitController({
        target: [0, 0, 0],
        distance: 5,
        azimuth: 0,
        elevation: 0,
      });

      const targetBefore = [...orbit.getTarget()] as [number, number, number];
      const posBefore = [...orbit.getPosition()] as [number, number, number];

      // When: we pan right (+X in screen space → +X in world for default view)
      orbit.pan(2, 0);

      const targetAfter = orbit.getTarget();
      const posAfter = orbit.getPosition();

      // Then: both target and position translated by the same delta
      const targetDelta = [
        targetAfter[0] - targetBefore[0],
        targetAfter[1] - targetBefore[1],
        targetAfter[2] - targetBefore[2],
      ];
      const posDelta = [
        posAfter[0] - posBefore[0],
        posAfter[1] - posBefore[1],
        posAfter[2] - posBefore[2],
      ];
      expect(targetDelta[0]).toBeCloseTo(posDelta[0], 4);
      expect(targetDelta[1]).toBeCloseTo(posDelta[1], 4);
      expect(targetDelta[2]).toBeCloseTo(posDelta[2], 4);

      // Target actually moved (not a no-op)
      const movedDist = Math.sqrt(targetDelta[0] ** 2 + targetDelta[1] ** 2 + targetDelta[2] ** 2);
      expect(movedDist).toBeGreaterThan(0.01);

      // Distance is 100% preserved
      expect(orbit.getDistance()).toBeCloseTo(5, 4);
    });
  });

  // ─── Test 6: fly_wasd_movement ────────────────────────────────

  describe("FlyController WASD", () => {
    it("should move camera in local coordinate directions", () => {
      // Given: fly controller at origin, looking down -Z
      // Angles in Radians. Yaw follows Right-Handed Rule (CCW = positive from top).
      const fly = new FlyController({
        position: [0, 0, 0],
        yaw: 0,    // radians: 0 = looking down -Z
        pitch: 0,  // radians: 0 = level
      });

      const posBefore = fly.getPosition();
      expect(posBefore).toEqual([0, 0, 0]);

      // When: we move forward (W key → -Z direction at yaw=0)
      fly.move("forward", 1.0);
      const posAfterW = fly.getPosition();
      expect(posAfterW[2]).toBeLessThan(0); // moved into -Z

      // When: we strafe right (D key → +X direction at yaw=0)
      fly.move("right", 1.0);
      const posAfterD = fly.getPosition();
      expect(posAfterD[0]).toBeGreaterThan(posAfterW[0]); // moved +X

      // When: we rotate yaw +π/2 (CCW from top = turn left) and move forward
      // After +π/2 yaw: forward direction becomes -X (Right-Handed Rule)
      fly.rotateYaw(Math.PI / 2);
      const posBeforeTurn = [...fly.getPosition()] as [number, number, number];
      fly.move("forward", 1.0);
      const posAfterTurn = fly.getPosition();
      // X should have decreased (moving in -X after π/2 CCW yaw)
      expect(posAfterTurn[0]).toBeLessThan(posBeforeTurn[0]);
    });
  });

  // ─── Test 7: matrix_upload_per_frame ──────────────────────────

  describe("CameraSystem matrix upload", () => {
    it("should upload CameraUniforms (176 bytes, 16-byte aligned) to GPU each frame", () => {
      // Given: a camera system with a mock device
      const device = createMockGPUDevice();
      const system = new CameraSystem(device, {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 1000,
      });

      // When: we update the camera (simulating a frame)
      system.setView([0, 0, 5], [0, 0, 0], [0, 1, 0]);
      system.uploadToGPU();

      // Then: writeBuffer was called to upload the uniform data
      expect(device.queue.writeBuffer).toHaveBeenCalled();

      // The uploaded data must match CameraUniforms WGSL struct (16-byte aligned):
      //   0-63:   view mat4x4f     64 bytes
      //   64-127: proj mat4x4f     64 bytes
      //   128-139: camera_pos vec3f 12 bytes + 4 pad
      //   144-151: focal vec2f      8 bytes
      //   152-159: viewport vec2f   8 bytes
      //   160-163: sh_degree u32    4 bytes
      //   164-167: sh_dim u32       4 bytes
      //   168-175: padding          8 bytes
      //   Total:                  176 bytes
      const writeCall = vi.mocked(device.queue.writeBuffer).mock.calls[0];
      const payload = writeCall[2] as ArrayBuffer;
      expect(payload.byteLength).toBe(176);

      // Verify camera_pos is written correctly at byte offset 128
      const f32 = new Float32Array(payload);
      expect(f32[32]).toBeCloseTo(0);   // camera_pos.x = eye[0]
      expect(f32[33]).toBeCloseTo(0);   // camera_pos.y = eye[1]
      expect(f32[34]).toBeCloseTo(5);   // camera_pos.z = eye[2]

      // When: we update again (second frame) with moved camera
      vi.mocked(device.queue.writeBuffer).mockClear();
      system.setView([1, 0, 5], [0, 0, 0], [0, 1, 0]);
      system.uploadToGPU();

      // Then: writeBuffer called again with updated position
      expect(device.queue.writeBuffer).toHaveBeenCalledTimes(1);
      const payload2 = vi.mocked(device.queue.writeBuffer).mock.calls[0][2] as ArrayBuffer;
      const f32_2 = new Float32Array(payload2);
      expect(f32_2[32]).toBeCloseTo(1); // camera_pos.x = 1 (moved)
    });
  });
});
