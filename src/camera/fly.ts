/**
 * Fly camera controller (free movement).
 *
 * WASD movement in camera-local coordinates. Mouse look via yaw/pitch.
 * Angles in radians. Yaw follows Right-Handed Rule (CCW = positive from top).
 * Yaw 0 = looking down -Z. Pitch 0 = level.
 */

export interface FlyConfig {
  position: [number, number, number];
  yaw: number;   // radians: 0 = looking down -Z
  pitch: number; // radians: 0 = level
}

const MAX_PITCH = Math.PI / 2 - 0.001;

export class FlyController {
  private position: [number, number, number];
  private yaw: number;
  private pitch: number;

  constructor(config: FlyConfig) {
    this.position = [...config.position];
    this.yaw = config.yaw;
    this.pitch = config.pitch;
  }

  /**
   * Move in a local direction by a given distance.
   *
   * Directions are relative to the camera's current orientation:
   * - "forward": along camera's -Z (into the screen)
   * - "back": along camera's +Z
   * - "right": along camera's +X
   * - "left": along camera's -X
   * - "up": along world +Y
   * - "down": along world -Y
   */
  move(direction: "forward" | "back" | "right" | "left" | "up" | "down", distance: number): void {
    // Forward vector in world space (yaw only, no pitch for ground movement)
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);

    // Forward = -Z in local space → rotated by yaw
    // At yaw=0: forward = (0, 0, -1)
    // At yaw=π/2 (CCW): forward = (-1, 0, 0)
    const fwdX = -sinY;
    const fwdZ = -cosY;

    // Right = +X in local space → rotated by yaw
    const rightX = cosY;
    const rightZ = -sinY;

    switch (direction) {
      case "forward":
        this.position[0] += fwdX * distance;
        this.position[2] += fwdZ * distance;
        break;
      case "back":
        this.position[0] -= fwdX * distance;
        this.position[2] -= fwdZ * distance;
        break;
      case "right":
        this.position[0] += rightX * distance;
        this.position[2] += rightZ * distance;
        break;
      case "left":
        this.position[0] -= rightX * distance;
        this.position[2] -= rightZ * distance;
        break;
      case "up":
        this.position[1] += distance;
        break;
      case "down":
        this.position[1] -= distance;
        break;
    }
  }

  /** Rotate yaw (radians, CCW = positive from top, Right-Handed Rule). */
  rotateYaw(delta: number): void {
    this.yaw += delta;
  }

  /** Rotate pitch (radians, clamped to avoid gimbal flip). */
  rotatePitch(delta: number): void {
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + delta));
  }

  getPosition(): [number, number, number] {
    return [...this.position];
  }

  getYaw(): number {
    return this.yaw;
  }

  getPitch(): number {
    return this.pitch;
  }
}
