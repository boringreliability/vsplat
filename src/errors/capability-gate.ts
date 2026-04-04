/**
 * Capability gate: checks all required browser features before init.
 *
 * Returns { error, warnings }. error is the FIRST missing hard requirement.
 * Cross-origin isolation is a soft check (warning only).
 */

import { type VsplatError, createVsplatError } from "./vsplat-error.js";

export interface CapabilityCheck {
  error: VsplatError | null;
  warnings: VsplatError[];
}

/**
 * Check all required browser capabilities.
 *
 * Order: WebGPU → Workers → OPFS (blocking). Cross-origin isolation (warning).
 */
export function checkCapabilities(): CapabilityCheck {
  const warnings: VsplatError[] = [];

  // 1. WebGPU (blocking)
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return { error: createVsplatError("UNSUPPORTED_WEBGPU"), warnings };
  }

  // 2. Web Workers (blocking)
  if (typeof Worker === "undefined") {
    return { error: createVsplatError("UNSUPPORTED_WORKER"), warnings };
  }

  // 3. OPFS (blocking)
  if (
    typeof navigator.storage === "undefined" ||
    typeof navigator.storage.getDirectory !== "function"
  ) {
    return { error: createVsplatError("UNSUPPORTED_OPFS"), warnings };
  }

  // 4. Cross-origin isolation (warning only)
  if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) {
    warnings.push(createVsplatError("UNSUPPORTED_CROSS_ORIGIN"));
  }

  return { error: null, warnings };
}
