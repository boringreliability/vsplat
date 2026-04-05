/**
 * GPU shader compilation error checking.
 *
 * Wraps compilationInfo() errors in VsplatError for structured error handling.
 */

import { type VsplatError, createVsplatError } from "./vsplat-error.js";

/**
 * Assert that a GPU shader module compiled without errors.
 *
 * @param module The compiled GPUShaderModule
 * @param shaderName Human-readable name for error reporting
 * @throws VsplatError with GPU_COMPILATION_FAILED if compilation errors exist
 */
export async function assertShaderCompiles(
  module: GPUShaderModule,
  shaderName: string,
): Promise<void> {
  const getInfo = (module as any).compilationInfo ?? (module as any).getCompilationInfo;
  if (typeof getInfo !== "function") return; // API not available — can't validate
  const info = await getInfo.call(module);
  const errors = info.messages.filter(
    (m: { type: string }) => m.type === "error",
  );
  if (errors.length > 0) {
    const errorText = errors
      .map((e: { message: string }) => e.message)
      .join("; ");
    const err = createVsplatError("GPU_COMPILATION_FAILED", {
      details: `${shaderName}: ${errorText}`,
    });
    throw err;
  }
}
