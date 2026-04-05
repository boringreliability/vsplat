/**
 * Camera system: manages view/projection matrices and uploads to GPU.
 *
 * Packs CameraUniforms into exactly 176 bytes matching the WGSL struct:
 *
 *   Offset  Size  Field
 *   0       64    view: mat4x4f
 *   64      64    proj: mat4x4f
 *   128     12    camera_pos: vec3f
 *   140      4    (padding to vec4 alignment)
 *   144      8    focal: vec2f
 *   152      8    viewport: vec2f
 *   160      4    sh_degree: u32
 *   164      4    sh_dim: u32
 *   168      8    (padding to 16-byte struct alignment)
 *   ────────────
 *   Total: 176 bytes
 *
 * Uses a shared ArrayBuffer with Float32Array + Uint32Array views
 * to write mixed f32/u32 types into the same memory block.
 */

import { perspectiveMatrix, lookAtMatrix } from "./math.js";

export interface CameraConfig {
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

/** Total byte size of CameraUniforms (16-byte aligned) */
const UNIFORM_SIZE = 176;

export class CameraSystem {
  private device: GPUDevice;
  private buffer: GPUBuffer;
  private projMatrix: Float32Array;

  // Shared backing buffer for packing mixed types
  private uniformData: ArrayBuffer;
  private f32View: Float32Array;
  private u32View: Uint32Array;

  // Current state
  private viewMatrix: Float32Array;
  private cameraPos: [number, number, number] = [0, 0, 0];

  // Configurable settings
  private focal: [number, number] = [500, 500];
  private viewport: [number, number] = [800, 600];
  private shDegree: number = 3;
  private shDim: number = 48;

  constructor(device: GPUDevice, config: CameraConfig) {
    this.device = device;

    this.buffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "camera-uniforms",
    });

    this.projMatrix = perspectiveMatrix(config.fov, config.aspect, config.near, config.far);
    this.viewMatrix = new Float32Array(16);

    // Shared ArrayBuffer with dual views for mixed f32/u32 packing
    this.uniformData = new ArrayBuffer(UNIFORM_SIZE);
    this.f32View = new Float32Array(this.uniformData);
    this.u32View = new Uint32Array(this.uniformData);
  }

  /** Update the view matrix from eye/target/up. */
  setView(
    eye: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
  ): void {
    this.viewMatrix = lookAtMatrix(eye, target, up);
    this.cameraPos = [...eye];
  }

  /** Set focal lengths (pixels). */
  setFocal(fx: number, fy: number): void {
    this.focal = [fx, fy];
  }

  /** Set viewport dimensions (pixels). */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  /** Set SH evaluation parameters. */
  setSH(degree: number, dim: number): void {
    this.shDegree = degree;
    this.shDim = dim;
  }

  /** Pack and upload CameraUniforms to GPU. Call once per frame. */
  uploadToGPU(): void {
    const f = this.f32View;
    const u = this.u32View;

    // Offset 0-63: view matrix (16 × f32 = 64 bytes)
    f.set(this.viewMatrix, 0);

    // Offset 64-127: proj matrix (16 × f32 = 64 bytes)
    f.set(this.projMatrix, 16);

    // Offset 128-139: camera_pos (3 × f32 = 12 bytes)
    f[32] = this.cameraPos[0];
    f[33] = this.cameraPos[1];
    f[34] = this.cameraPos[2];
    f[35] = 0; // padding after camera_pos (explicit zero)

    // Offset 144-151: focal (2 × f32 = 8 bytes)
    // Auto-derive from projection matrix for guaranteed consistency:
    // focalX = proj[0][0] * viewport.x * 0.5
    // focalY = proj[1][1] * viewport.y * 0.5
    f[36] = this.projMatrix[0] * this.viewport[0] * 0.5;
    f[37] = this.projMatrix[5] * this.viewport[1] * 0.5;

    // Offset 152-159: viewport (2 × f32 = 8 bytes)
    f[38] = this.viewport[0];
    f[39] = this.viewport[1];

    // Offset 160-163: sh_degree (u32)
    u[40] = this.shDegree;

    // Offset 164-167: sh_dim (u32)
    u[41] = this.shDim;

    // Offset 168-175: padding (explicit zero to prevent memory corruption on reuse)
    u[42] = 0;
    u[43] = 0;

    this.device.queue.writeBuffer(this.buffer, 0, this.uniformData);
  }

  /** Get the GPU buffer for binding. */
  getBuffer(): GPUBuffer {
    return this.buffer;
  }

  /** Get the projection matrix (Column-Major Float32Array). */
  getProjectionMatrix(): Float32Array {
    return this.projMatrix;
  }
}
