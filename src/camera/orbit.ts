/**
 * Orbit camera controller.
 *
 * Camera moves on a sphere around a target point.
 * Angles in radians. Azimuth 0 = +Z axis, positive rotation toward +X (Right-Handed Rule).
 */

export interface OrbitConfig {
  target: [number, number, number];
  distance: number;
  azimuth: number;   // radians
  elevation: number; // radians
}

const MIN_DISTANCE = 0.01;
const MAX_ELEVATION = Math.PI / 2 - 0.001;

export class OrbitController {
  private target: [number, number, number];
  private distance: number;
  private azimuth: number;
  private elevation: number;

  constructor(config: OrbitConfig) {
    this.target = [...config.target];
    this.distance = config.distance;
    this.azimuth = config.azimuth;
    this.elevation = config.elevation;
  }

  /** Rotate by delta azimuth and delta elevation (radians). */
  rotate(deltaAzimuth: number, deltaElevation: number): void {
    this.azimuth += deltaAzimuth;
    this.elevation = Math.max(
      -MAX_ELEVATION,
      Math.min(MAX_ELEVATION, this.elevation + deltaElevation),
    );
  }

  /** Zoom by delta distance (negative = closer). Clamped to MIN_DISTANCE. */
  zoom(delta: number): void {
    this.distance = Math.max(MIN_DISTANCE, this.distance + delta);
  }

  /**
   * Pan in screen-space (right, up). Translates both target and camera
   * by the same world-space delta, preserving distance exactly.
   */
  pan(deltaRight: number, deltaUp: number): void {
    // Camera's local right and up vectors on the orbit sphere
    const sinA = Math.sin(this.azimuth);
    const cosA = Math.cos(this.azimuth);
    const sinE = Math.sin(this.elevation);
    const cosE = Math.cos(this.elevation);

    // Right vector (perpendicular to forward in XZ plane)
    const rx = cosA;
    const rz = -sinA;

    // Up vector (perpendicular to forward and right)
    const ux = -sinE * sinA;
    const uy = cosE;
    const uz = -sinE * cosA;

    this.target[0] += rx * deltaRight + ux * deltaUp;
    this.target[1] += uy * deltaUp;
    this.target[2] += rz * deltaRight + uz * deltaUp;
  }

  /** Get camera position on the orbit sphere. */
  getPosition(): [number, number, number] {
    const cosE = Math.cos(this.elevation);
    return [
      this.target[0] + this.distance * Math.sin(this.azimuth) * cosE,
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * Math.cos(this.azimuth) * cosE,
    ];
  }

  getTarget(): [number, number, number] {
    return [...this.target];
  }

  getDistance(): number {
    return this.distance;
  }
}
