/**
 * Runtime feature detection for browser capabilities.
 * Detects WebGPU, OPFS, memory64 Wasm, SharedArrayBuffer, and COOP/COEP.
 */

export interface FeatureFlags {
  /** WebGPU available via navigator.gpu */
  webgpu: boolean;
  /** Origin Private File System available */
  opfs: boolean;
  /** Wasm memory64 extension supported */
  memory64: boolean;
  /** SharedArrayBuffer available (requires COOP/COEP) */
  sharedArrayBuffer: boolean;
  /** Cross-origin isolated context (COOP + COEP headers set) */
  crossOriginIsolated: boolean;
}

export async function detectFeatures(): Promise<FeatureFlags> {
  const [webgpu, opfs, memory64] = await Promise.all([
    detectWebGPU(),
    detectOPFS(),
    detectMemory64(),
  ]);

  return {
    webgpu,
    opfs,
    memory64,
    sharedArrayBuffer: detectSharedArrayBuffer(),
    crossOriginIsolated: detectCrossOriginIsolated(),
  };
}

export async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

export async function detectOPFS(): Promise<boolean> {
  try {
    const storage = (navigator as any).storage;
    if (!storage?.getDirectory) return false;
    await storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect memory64 by validating a minimal Wasm module that declares
 * a 64-bit memory. The key byte is 0x05 (memory64 limits flag)
 * instead of the standard 0x01 (32-bit min-only limits).
 */
export async function detectMemory64(): Promise<boolean> {
  try {
    const validate = (WebAssembly as any).validate;
    if (typeof validate !== "function") return false;

    // Minimal Wasm module: magic + version + memory section with 64-bit flag
    // Header: \0asm\1\0\0\0
    // Section 5 (memory): 1 memory, flags=0x05 (64-bit, min-only), min=1
    const memory64Module = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic: \0asm
      0x01, 0x00, 0x00, 0x00, // version: 1
      0x05, 0x04, 0x01,       // memory section, 4 bytes, 1 memory
      0x05, 0x01, 0x00,       // flags=0x05 (64-bit, min-only), min=0 (LEB128)
    ]);

    return validate(memory64Module);
  } catch {
    return false;
  }
}

export function detectSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

export function detectCrossOriginIsolated(): boolean {
  return (globalThis as any).crossOriginIsolated === true;
}
