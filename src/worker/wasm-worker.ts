/**
 * Production Worker script for vsplat.
 *
 * Loads the Wasm module via wasm-bindgen JS glue, handles init/load/query-buffers/ping.
 * This is the real version of what Ward 15's tests mocked.
 */

/// <reference lib="webworker" />

// Module state — set during init, used by all subsequent messages
let mod: typeof import("../../pkg/vsplat_core.js") | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

self.onmessage = async (event: MessageEvent) => {
  try {
    const msg = event.data;

    switch (msg.type) {
      case "init": {
        // Dynamic import of the wasm-bindgen JS glue
        mod = await import(/* @vite-ignore */ msg.wasmUrl);
        // mod.default() is __wbg_init — loads and instantiates the Wasm module.
        // Returns instance.exports which includes memory.
        const exports = await mod.default();
        wasmMemory = exports.memory as WebAssembly.Memory;
        // Call our FFI init() to create the World
        mod.init();
        self.postMessage({ type: "ready" });
        break;
      }

      case "load": {
        if (!mod) {
          self.postMessage({ type: "error", message: "Not initialized" });
          break;
        }
        const data = new Uint8Array(msg.plyData);
        const count = mod.load_ply(data);
        self.postMessage({ type: "loaded", splatCount: count });
        break;
      }

      case "query-buffers": {
        if (!mod || !wasmMemory) {
          self.postMessage({ type: "error", message: "Not initialized" });
          break;
        }

        // Create Float32Array view on Wasm memory, slice to copy out
        const mem = new Float32Array(wasmMemory.buffer);

        const posPtr = mod.get_positions_ptr() / 4;
        const posLen = mod.get_positions_len();
        const positions = mem.slice(posPtr, posPtr + posLen).buffer;

        const rotPtr = mod.get_rotations_ptr() / 4;
        const rotLen = mod.get_rotations_len();
        const rotations = mem.slice(rotPtr, rotPtr + rotLen).buffer;

        const scPtr = mod.get_scales_ptr() / 4;
        const scLen = mod.get_scales_len();
        const scales = mem.slice(scPtr, scPtr + scLen).buffer;

        const opPtr = mod.get_opacities_ptr() / 4;
        const opLen = mod.get_opacities_len();
        const opacities = mem.slice(opPtr, opPtr + opLen).buffer;

        const shPtr = mod.get_sh_ptr() / 4;
        const shLen = mod.get_sh_len();
        const sh = mem.slice(shPtr, shPtr + shLen).buffer;

        self.postMessage(
          {
            type: "buffers",
            positions, rotations, scales, opacities, sh,
            shDim: mod.get_sh_dim(),
            splatCount: mod.get_splat_count(),
          },
          [positions, rotations, scales, opacities, sh],
        );
        break;
      }

      case "ping":
        self.postMessage({ type: "pong" });
        break;

      default:
        self.postMessage({ type: "error", message: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
