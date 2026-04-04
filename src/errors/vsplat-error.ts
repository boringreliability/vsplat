/**
 * Structured error types for vsplat.
 *
 * Every error path in vsplat produces a VsplatError, not raw Error or strings.
 * Each variant has a machine-readable code, user-actionable message, optional
 * technical details, and a recoverable flag.
 */

export type VsplatErrorCode =
  | "UNSUPPORTED_WEBGPU"
  | "UNSUPPORTED_OPFS"
  | "UNSUPPORTED_WORKER"
  | "UNSUPPORTED_CROSS_ORIGIN"
  | "GPU_COMPILATION_FAILED"
  | "SCENE_TOO_LARGE"
  | "WORKER_CRASHED"
  | "BRIDGE_TIMEOUT"
  | "LOAD_FAILED";

/**
 * VsplatError extends Error so it works with throw/catch/toThrow patterns.
 * Error.message includes details for pattern matching in tests and logging.
 */
export class VsplatError extends Error {
  code: VsplatErrorCode;
  details?: string;
  recoverable: boolean;

  constructor(code: VsplatErrorCode, message: string, recoverable: boolean, details?: string) {
    // Error.message includes details so toThrow(/pattern/) matches technical info
    super(details ? `${message} (${details})` : message);
    this.name = "VsplatError";
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
  }
}

export const ALL_ERROR_CODES: VsplatErrorCode[] = [
  "UNSUPPORTED_WEBGPU",
  "UNSUPPORTED_OPFS",
  "UNSUPPORTED_WORKER",
  "UNSUPPORTED_CROSS_ORIGIN",
  "GPU_COMPILATION_FAILED",
  "SCENE_TOO_LARGE",
  "WORKER_CRASHED",
  "BRIDGE_TIMEOUT",
  "LOAD_FAILED",
];

const ERROR_DEFAULTS: Record<VsplatErrorCode, { message: string; recoverable: boolean }> = {
  UNSUPPORTED_WEBGPU: {
    message: "Your browser does not support WebGPU. Try Chrome 113+ or Edge 113+.",
    recoverable: false,
  },
  UNSUPPORTED_OPFS: {
    message: "Your browser does not support the Origin Private File System (OPFS). Try Chrome 102+ or Edge 102+.",
    recoverable: false,
  },
  UNSUPPORTED_WORKER: {
    message: "Your browser does not support Web Workers. Try a modern browser.",
    recoverable: false,
  },
  UNSUPPORTED_CROSS_ORIGIN: {
    message: "Cross-origin isolation is not enabled. SharedArrayBuffer optimizations are unavailable. The site needs COOP/COEP headers.",
    recoverable: false,
  },
  GPU_COMPILATION_FAILED: {
    message: "A GPU shader failed to compile. This is a bug — please report it.",
    recoverable: false,
  },
  SCENE_TOO_LARGE: {
    message: "The scene is too large for available memory. Try a smaller file or close other tabs.",
    recoverable: false,
  },
  WORKER_CRASHED: {
    message: "The background worker crashed. You can try reloading the page.",
    recoverable: true,
  },
  BRIDGE_TIMEOUT: {
    message: "A background operation timed out. The worker may be overloaded. You can try again.",
    recoverable: true,
  },
  LOAD_FAILED: {
    message: "Failed to load the scene file. The file may be corrupt or in an unsupported format.",
    recoverable: true,
  },
};

/**
 * Create a VsplatError with defaults for the given code.
 * Optionally override message, details, or recoverable.
 */
export function createVsplatError(
  code: VsplatErrorCode,
  overrides?: { message?: string; details?: string; recoverable?: boolean },
): VsplatError {
  const defaults = ERROR_DEFAULTS[code];
  return new VsplatError(
    code,
    overrides?.message ?? defaults.message,
    overrides?.recoverable ?? defaults.recoverable,
    overrides?.details,
  );
}
