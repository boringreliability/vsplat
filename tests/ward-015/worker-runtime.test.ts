/**
 * Ward 015 — Production Worker Runtime Tests
 *
 * Category A: Rust FFI (4 tests in cargo test, not here)
 *   Verify wasm_bindgen exports: init, load_ply, pointer/length getters.
 *
 * Category B: TypeScript Bridge & Protocol (8 tests)
 *   Verify the updated bridge: init handshake with timeout, PLY load with
 *   transfer, buffer query with transferred ArrayBuffers, terminate cleanup,
 *   error propagation, and backward compat with Ward 1 ping/pong.
 *
 * All tests use MockWorker injection via _testWorker (Ward 1 pattern).
 * Real Wasm instantiation is Ward 17 browser test scope.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkerBridge,
  type WorkerBridge,
  type WorkerMessage,
} from "../../src/worker/bridge.js";

// ─── Mock Worker ─────────────────────────────────────────────────

type MessageHandler = (msg: WorkerMessage) => WorkerMessage | null | Promise<WorkerMessage | null>;

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private _terminated = false;
  terminate = vi.fn(() => { this._terminated = true; });

  constructor(private _handler: MessageHandler) {}

  postMessage(data: WorkerMessage, _transfer?: Transferable[]): void {
    if (this._terminated) throw new Error("Worker terminated");

    setTimeout(async () => {
      if (!this.onmessage || !this._handler) return;
      try {
        const response = await this._handler(data);
        if (response) {
          this.onmessage(new MessageEvent("message", { data: response }));
        }
      } catch (err) {
        if (this.onerror) {
          this.onerror(new ErrorEvent("error", { message: String(err) }));
        }
      }
    }, 0);
  }
}

/** Standard mock handler: responds to init, load, query-buffers, ping */
function createStandardHandler(): MessageHandler {
  return (msg) => {
    switch (msg.type) {
      case "init":
        return { type: "ready" };
      case "load":
        return { type: "loaded", splatCount: 1000 } as WorkerMessage;
      case "query-buffers":
        return {
          type: "buffers",
          positions: new ArrayBuffer(12000),  // 1000 * 3 * 4
          sh: new ArrayBuffer(144000),         // 1000 * 36 * 4
          opacities: new ArrayBuffer(4000),    // 1000 * 4
          rotations: new ArrayBuffer(16000),   // 1000 * 4 * 4
          scales: new ArrayBuffer(12000),      // 1000 * 3 * 4
          shDim: 36,
          splatCount: 1000,
        } as unknown as WorkerMessage;
      case "ping":
        return { type: "pong" };
      default:
        return null;
    }
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 015: Production Worker Runtime — Bridge & Protocol", () => {

  // ─── B1: bridge_init_handshake ──────────────────────────────────

  it("B1: createWorkerBridge sends init, waits for ready, resolves with bridge", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    expect(bridge.ready).toBe(true);
  });

  // ─── B2: bridge_init_timeout ────────────────────────────────────

  it("B2: bridge rejects with descriptive error if Worker does not respond within timeout", async () => {
    // Worker that never responds to init
    const silentWorker = new MockWorker(() => null);

    await expect(
      createWorkerBridge("mock://slow.wasm", {
        _testWorker: silentWorker as unknown as Worker,
        _initTimeoutMs: 50, // 50ms timeout for test speed
      }),
    ).rejects.toThrow(/timeout|slow\.wasm/i);
  });

  // ─── B3: bridge_load_ply ────────────────────────────────────────

  it("B3: bridge.loadPly transfers ArrayBuffer and receives splatCount", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    const plyData = new ArrayBuffer(1024); // fake PLY bytes
    const result = await bridge.loadPly(plyData);

    expect(result.splatCount).toBe(1000);
  });

  // ─── B4: bridge_get_buffers ─────────────────────────────────────

  it("B4: bridge.getBuffers returns Float32Array-wrapped transferred ArrayBuffers", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    const buffers = await bridge.getBuffers();

    expect(buffers.positions).toBeInstanceOf(Float32Array);
    expect(buffers.positions.length).toBe(3000); // 1000 * 3
    expect(buffers.sh).toBeInstanceOf(Float32Array);
    expect(buffers.sh.length).toBe(36000); // 1000 * 36
    expect(buffers.opacities).toBeInstanceOf(Float32Array);
    expect(buffers.opacities.length).toBe(1000);
    expect(buffers.rotations).toBeInstanceOf(Float32Array);
    expect(buffers.rotations.length).toBe(4000); // 1000 * 4
    expect(buffers.scales).toBeInstanceOf(Float32Array);
    expect(buffers.scales.length).toBe(3000); // 1000 * 3
    expect(buffers.shDim).toBe(36);
    expect(buffers.splatCount).toBe(1000);
  });

  // ─── B5: bridge_terminate_cleanup ───────────────────────────────

  it("B5: terminate sets ready=false, calls worker.terminate(), rejects subsequent calls", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    expect(bridge.ready).toBe(true);
    bridge.terminate();

    expect(bridge.ready).toBe(false);
    expect(mock.terminate).toHaveBeenCalled();

    await expect(bridge.loadPly(new ArrayBuffer(0))).rejects.toThrow(/terminated/i);
  });

  // ─── B6: bridge_error_propagation ───────────────────────────────

  it("B6: Worker error message rejects pending promise", async () => {
    const mock = new MockWorker((msg) => {
      if (msg.type === "init") return { type: "ready" };
      if (msg.type === "load") {
        return { type: "error", message: "Invalid PLY header" } as WorkerMessage;
      }
      return null;
    });

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    await expect(bridge.loadPly(new ArrayBuffer(0)))
      .rejects.toThrow(/Invalid PLY header/i);
  });

  // ─── B7: bridge_load_after_terminate_rejects ────────────────────

  it("B7: loadPly after terminate rejects immediately without sending message", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);
    const postSpy = vi.spyOn(mock, "postMessage");

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    const callsBefore = postSpy.mock.calls.length;
    bridge.terminate();

    await expect(bridge.loadPly(new ArrayBuffer(0))).rejects.toThrow(/terminated/i);

    // No new messages sent after terminate
    expect(postSpy.mock.calls.length).toBe(callsBefore);
  });

  // ─── B8: bridge_ping_pong_still_works ───────────────────────────

  it("B8: Ward 1 ping/pong contract still holds with updated bridge", async () => {
    const handler = createStandardHandler();
    const mock = new MockWorker(handler);

    const bridge = await createWorkerBridge("mock://test.wasm", {
      _testWorker: mock as unknown as Worker,
    });

    const result = await bridge.ping();
    expect(result).toBe("pong");
  });
});
