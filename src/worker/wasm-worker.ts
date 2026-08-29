/**
 * Production Worker script for vsplat.
 *
 * Loads the Wasm module via wasm-bindgen JS glue, handles init/load/query-buffers/ping,
 * plus Ward 26's LAS/LAZ protocol (`las-*`).
 * This is the real version of what Ward 15's tests mocked.
 */

/// <reference lib="webworker" />

import { createLasWorkerHandler, type LasWasmModule } from "./las-worker-handler.js";

// Module state — set during init, used by all subsequent messages
let mod: typeof import("../../pkg/vsplat_core.js") | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
/** Ward 26: modtagersiden af Ward 21's LasBridge-protokol. Sat ved init. */
let handleLas: ((msg: unknown) => void) | null = null;

self.onmessage = async (event: MessageEvent) => {
  try {
    const msg = event.data;

    // Ward 26: LAS/LAZ-beskederne har deres egen handler, så protokollen kan
    // testes uden en rigtig Worker. Alt andet falder igennem til switch'en.
    if (typeof msg?.type === "string" && msg.type.startsWith("las-")) {
      if (!handleLas) {
        self.postMessage({ type: "las-error", message: "Not initialized" });
        return;
      }
      handleLas(msg);
      return;
    }

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
        // Eksplicit adapter frem for spread af module-namespacet: wasm-bindgen's
        // eksporter er getters, og en spread ville tie stille hvis en mangler.
        const m = mod;
        const lasModule: LasWasmModule = {
          memory: wasmMemory,
          las_init: () => m.las_init(),
          las_parse_chunk: (data) => m.las_parse_chunk(data),
          las_point_count: () => m.las_point_count(),
          las_compressed: () => m.las_compressed(),
          las_positions_ptr: () => m.las_positions_ptr(),
          las_positions_len: () => m.las_positions_len(),
          las_intensity_ptr: () => m.las_intensity_ptr(),
          las_intensity_len: () => m.las_intensity_len(),
          las_rgb_ptr: () => m.las_rgb_ptr(),
          las_rgb_len: () => m.las_rgb_len(),
          las_classification_ptr: () => m.las_classification_ptr(),
          las_classification_len: () => m.las_classification_len(),
        };
        handleLas = createLasWorkerHandler(
          lasModule,
          (out, transfer) => {
            if (transfer) self.postMessage(out, transfer);
            else self.postMessage(out);
          },
        );
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

      case "sort": {
        if (!mod || !wasmMemory) {
          self.postMessage({ type: "error", message: "Not initialized" });
          break;
        }
        const count = mod.sort_by_depth(msg.camX, msg.camY, msg.camZ, msg.dirX, msg.dirY, msg.dirZ);
        // Copy sorted indices from Wasm memory and transfer
        const mem = new Uint32Array(wasmMemory.buffer);
        const idxPtr = mod.get_sorted_indices_ptr() / 4;
        const idxLen = mod.get_sorted_indices_len();
        const sortedIndices = mem.slice(idxPtr, idxPtr + idxLen).buffer;
        self.postMessage(
          { type: "sorted", sortedIndices, count },
          [sortedIndices],
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
