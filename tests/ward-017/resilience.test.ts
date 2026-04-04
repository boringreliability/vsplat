/**
 * Ward 017 — Runtime Resilience & Fallbacks Tests
 *
 * Category A: Error Types & Capability Gate (5 tests)
 * Category B: Bridge Resilience (2 tests)
 * Category C: GPU & Memory (3 tests)
 *
 * Tests verify structured error types, capability detection, bridge timeouts,
 * Worker crash handling, GPU compilation error surfacing, and memory estimation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  type VsplatError,
  type VsplatErrorCode,
  createVsplatError,
  ALL_ERROR_CODES,
} from "../../src/errors/vsplat-error.js";
import {
  checkCapabilities,
} from "../../src/errors/capability-gate.js";
import {
  estimateSceneMemory,
  checkSceneMemory,
} from "../../src/errors/memory-pressure.js";
import {
  assertShaderCompiles,
} from "../../src/errors/shader-check.js";
import {
  createWorkerBridge,
  type WorkerMessage,
} from "../../src/worker/bridge.js";

// ─── Mock Worker ─────────────────────────────────────────────────

type MessageHandler = (msg: WorkerMessage) => WorkerMessage | null;

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();

  constructor(private _handler: MessageHandler) {}

  postMessage(data: WorkerMessage): void {
    setTimeout(() => {
      if (!this.onmessage || !this._handler) return;
      const response = this._handler(data);
      if (response) {
        this.onmessage(new MessageEvent("message", { data: response }));
      }
    }, 0);
  }

  simulateCrash(message: string): void {
    if (this.onerror) {
      // ErrorEvent doesn't exist in Node — use a plain object matching the interface
      this.onerror({ message } as unknown as ErrorEvent);
    }
  }
}

// ─── Category A: Error Types & Capability Gate ───────────────────

describe("Ward 017: Runtime Resilience & Fallbacks", () => {

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Category A: Error Types & Capability Gate", () => {

    // ─── A1: capability_gate_all_present ───────────────────────────

    it("A1: all features present → no error, no warnings", () => {
      vi.stubGlobal("navigator", {
        gpu: { requestAdapter: vi.fn() },
        storage: { getDirectory: vi.fn() },
      });
      vi.stubGlobal("Worker", class {});
      vi.stubGlobal("crossOriginIsolated", true);

      const result = checkCapabilities();

      expect(result.error).toBeNull();
      expect(result.warnings).toEqual([]);
    });

    // ─── A2: capability_gate_no_webgpu ────────────────────────────

    it("A2: missing WebGPU → UNSUPPORTED_WEBGPU with actionable message", () => {
      vi.stubGlobal("navigator", {
        storage: { getDirectory: vi.fn() },
      });
      vi.stubGlobal("Worker", class {});
      vi.stubGlobal("crossOriginIsolated", true);

      const result = checkCapabilities();

      expect(result.error).not.toBeNull();
      expect(result.error!.code).toBe("UNSUPPORTED_WEBGPU");
      expect(result.error!.message).toMatch(/chrome|edge|browser/i);
      expect(result.error!.recoverable).toBe(false);
    });

    // ─── A3: capability_gate_no_opfs ──────────────────────────────

    it("A3: missing OPFS → UNSUPPORTED_OPFS", () => {
      vi.stubGlobal("navigator", {
        gpu: { requestAdapter: vi.fn() },
        storage: {},
      });
      vi.stubGlobal("Worker", class {});
      vi.stubGlobal("crossOriginIsolated", true);

      const result = checkCapabilities();

      expect(result.error).not.toBeNull();
      expect(result.error!.code).toBe("UNSUPPORTED_OPFS");
      expect(result.error!.recoverable).toBe(false);
    });

    // ─── A4: error_types_actionable ───────────────────────────────

    it("A4: every VsplatErrorCode has non-empty message and correct recoverable flag", () => {
      for (const code of ALL_ERROR_CODES) {
        const err = createVsplatError(code);
        expect(err.code).toBe(code);
        expect(err.message.length).toBeGreaterThan(0);
        expect(typeof err.recoverable).toBe("boolean");

        if (code.startsWith("UNSUPPORTED_")) {
          expect(err.recoverable).toBe(false);
        }
        if (code === "WORKER_CRASHED" || code === "BRIDGE_TIMEOUT") {
          expect(err.recoverable).toBe(true);
        }
        if (code === "GPU_COMPILATION_FAILED") {
          expect(err.recoverable).toBe(false);
        }
      }
    });

    // ─── A5: capability_gate_no_cross_origin_warns ────────────────

    it("A5: missing cross-origin isolation → no error, warning with UNSUPPORTED_CROSS_ORIGIN", () => {
      vi.stubGlobal("navigator", {
        gpu: { requestAdapter: vi.fn() },
        storage: { getDirectory: vi.fn() },
      });
      vi.stubGlobal("Worker", class {});
      vi.stubGlobal("crossOriginIsolated", false);

      const result = checkCapabilities();

      // Not blocking — app works without SharedArrayBuffer
      expect(result.error).toBeNull();
      // But produces a warning
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0].code).toBe("UNSUPPORTED_CROSS_ORIGIN");
    });
  });

  // ─── Category B: Bridge Resilience ─────────────────────────────

  describe("Category B: Bridge Resilience", () => {

    // ─── B1: bridge_load_timeout ──────────────────────────────────

    it("B1: loadPly with non-responding Worker rejects with BRIDGE_TIMEOUT", async () => {
      const mock = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        return null; // load → no response
      });

      const bridge = await createWorkerBridge("mock://test.wasm", {
        worker: mock as unknown as Worker,
        timeouts: { init: 100, loadPly: 50, getBuffers: 50, ping: 50 },
      });

      await expect(bridge.loadPly(new ArrayBuffer(10)))
        .rejects.toThrow(/timed out|timeout/i);
    });

    // ─── B2: worker_crash_rejects_pending ─────────────────────────

    it("B2: Worker onerror rejects all pending and sets ready=false", async () => {
      const mock = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        return null;
      });

      const bridge = await createWorkerBridge("mock://test.wasm", {
        worker: mock as unknown as Worker,
        timeouts: { init: 100, loadPly: 5000, getBuffers: 5000, ping: 5000 },
      });

      const loadPromise = bridge.loadPly(new ArrayBuffer(10));

      setTimeout(() => mock.simulateCrash("Out of memory"), 10);

      await expect(loadPromise).rejects.toThrow(/out of memory|worker/i);
      expect(bridge.ready).toBe(false);
    });
  });

  // ─── Category C: GPU & Memory ──────────────────────────────────

  describe("Category C: GPU & Memory", () => {

    // ─── C1: gpu_compilation_failure_surfaced ──────────────────────

    it("C1: assertShaderCompiles rejects with GPU_COMPILATION_FAILED on error", async () => {
      const mockModule = {
        compilationInfo: async () => ({
          messages: [{ type: "error", message: "expected '(' for function declaration" }],
        }),
      } as unknown as GPUShaderModule;

      await expect(assertShaderCompiles(mockModule, "splat-shader"))
        .rejects.toMatchObject({
          code: "GPU_COMPILATION_FAILED",
          recoverable: false,
        });

      // Details should include shader name and error text
      try {
        await assertShaderCompiles(mockModule, "splat-shader");
      } catch (e) {
        const err = e as VsplatError;
        expect(err.details).toContain("splat-shader");
        expect(err.details).toContain("expected '('");
      }
    });

    // ─── C2: memory_pressure_warning ──────────────────────────────

    it("C2: large scene → SCENE_TOO_LARGE; small scene → null", () => {
      const bigError = checkSceneMemory(10_000_000, 48);
      expect(bigError).not.toBeNull();
      expect(bigError!.code).toBe("SCENE_TOO_LARGE");
      expect(bigError!.recoverable).toBe(false);

      const smallError = checkSceneMemory(100_000, 3);
      expect(smallError).toBeNull();
    });

    // ─── C3: memory_estimate_accuracy ─────────────────────────────

    it("C3: estimateSceneMemory returns reasonable value and scales linearly", () => {
      const estimate = estimateSceneMemory(1_000_000, 48);

      expect(estimate).toBeGreaterThan(500_000_000);
      expect(estimate).toBeLessThan(2_000_000_000);

      const estimate2 = estimateSceneMemory(2_000_000, 48);
      const ratio = estimate2 / estimate;
      expect(ratio).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(2.2);
    });
  });
});
