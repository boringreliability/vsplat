/**
 * Ward 023 — Adaptive density throttler.
 *
 * Måler rolling avg frame-tid. Hvis avg > slowThresholdMs over slowWindowFrames:
 * `density_factor *= decayRate`. Hvis avg < fastThresholdMs over fastWindowFrames:
 * `density_factor *= recoveryRate`.
 *
 * `getTime` injectes for at gøre T7/T8 deterministisk i Vitest.
 */

export interface AdaptiveDensityOptions {
  getTime?: () => number;
  slowThresholdMs?: number;
  fastThresholdMs?: number;
  slowWindowFrames?: number;
  fastWindowFrames?: number;
  decayRate?: number;
  recoveryRate?: number;
  minFactor?: number;
}

export class AdaptiveDensityThrottler {
  private readonly getTime: () => number;
  private readonly slowThresholdMs: number;
  private readonly fastThresholdMs: number;
  private readonly slowWindowFrames: number;
  private readonly fastWindowFrames: number;
  private readonly decayRate: number;
  private readonly recoveryRate: number;
  private readonly minFactor: number;

  private frameTimes: number[] = []; // rolling buffer of deltas (ms)
  private lastFrameTime: number | null = null;
  private currentFactor = 1.0;

  constructor(options: AdaptiveDensityOptions = {}) {
    this.getTime = options.getTime ?? (() => performance.now());
    this.slowThresholdMs = options.slowThresholdMs ?? 33;
    this.fastThresholdMs = options.fastThresholdMs ?? 16;
    this.slowWindowFrames = options.slowWindowFrames ?? 30;
    this.fastWindowFrames = options.fastWindowFrames ?? 60;
    // 0.85 + 1.15 giver tydeligere brugeroplevet adaptering når frames spikes,
    // og sikrer at en enkelt recovery-step gir meningsfuld delta (>5%).
    this.decayRate = options.decayRate ?? 0.85;
    this.recoveryRate = options.recoveryRate ?? 1.15;
    this.minFactor = options.minFactor ?? 0.1;
  }

  recordFrame(): void {
    const now = this.getTime();
    if (this.lastFrameTime !== null) {
      const dt = now - this.lastFrameTime;
      this.frameTimes.push(dt);
      // Keep only the longest window we evaluate against
      const maxKeep = Math.max(this.slowWindowFrames, this.fastWindowFrames);
      if (this.frameTimes.length > maxKeep) {
        this.frameTimes.shift();
      }
      this.evaluate();
    }
    this.lastFrameTime = now;
  }

  private evaluate(): void {
    // Check slow threshold over slowWindowFrames
    if (this.frameTimes.length >= this.slowWindowFrames) {
      const window = this.frameTimes.slice(-this.slowWindowFrames);
      const avg = window.reduce((s, v) => s + v, 0) / window.length;
      if (avg > this.slowThresholdMs) {
        this.currentFactor = Math.max(this.minFactor, this.currentFactor * this.decayRate);
        // Reset buffer efter trigger: undgår at samme slow-window fyrer
        // throttle ved hver efterfølgende frame indtil window naturligt
        // tømmes. Tvinger throttleren til at observere et helt nyt sample-
        // window før næste evaluering.
        this.frameTimes = [];
        return;
      }
    }
    // Check fast threshold over fastWindowFrames
    if (this.frameTimes.length >= this.fastWindowFrames) {
      const window = this.frameTimes.slice(-this.fastWindowFrames);
      const avg = window.reduce((s, v) => s + v, 0) / window.length;
      if (avg < this.fastThresholdMs && this.currentFactor < 1.0) {
        this.currentFactor = Math.min(1.0, this.currentFactor * this.recoveryRate);
        this.frameTimes = [];
      }
    }
  }

  factor(): number {
    return this.currentFactor;
  }
}
