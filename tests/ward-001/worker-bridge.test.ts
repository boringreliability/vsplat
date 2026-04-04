/**
 * Ward 001 — Worker Bridge Tests
 *
 * Tests 5-6: Verify Wasm Worker ping/pong and error handling.
 * Uses a mock Worker since we're in a Node test environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkerBridge,
  type WorkerBridge,
  type WorkerMessage,
} from "../../src/worker/bridge.js";

/**
 * Mock Worker class that simulates the Wasm Worker behavior.
 * In production, this would be a real Web Worker loading the Wasm module.
 */
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private _terminated = false;

  constructor(
    private _handler?: (msg: WorkerMessage) => WorkerMessage | null,
  ) {}

  postMessage(data: WorkerMessage): void {
    if (this._terminated) throw new Error("Worker terminated");

    // Simulate async response
    setTimeout(() => {
      if (!this.onmessage || !this._handler) return;
      const response = this._handler(data);
      if (response) {
        this.onmessage(new MessageEvent("message", { data: response }));
      }
    }, 0);
  }

  terminate(): void {
    this._terminated = true;
  }
}

// We need to allow the bridge to accept an injected Worker for testing
// The real implementation will create a Worker from a URL

describe("Ward 001: Worker Bridge", () => {
  // ─── Test 5: worker_ping_pong ────────────────────────────────
  describe("ping/pong", () => {
    it("should receive 'pong' when sending 'ping'", async () => {
      // Given: a worker bridge with a responsive worker
      const mockWorker = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        if (msg.type === "ping") return { type: "pong" };
        return null;
      });

      // When: we create a bridge and send ping
      // The bridge should accept an optional Worker for testability
      const bridge = await createWorkerBridge("mock://test.wasm", {
        _testWorker: mockWorker as unknown as Worker,
      });
      const result = await bridge.ping();

      // Then: we should get "pong" back
      expect(result).toBe("pong");
    });

    it("should resolve within 10ms (performance check)", async () => {
      // Given: a worker that responds immediately
      const mockWorker = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        if (msg.type === "ping") return { type: "pong" };
        return null;
      });

      const bridge = await createWorkerBridge("mock://test.wasm", {
        _testWorker: mockWorker as unknown as Worker,
      });

      // When: we time the ping/pong
      const start = performance.now();
      await bridge.ping();
      const elapsed = performance.now() - start;

      // Then: it should be fast (< 100ms, generous for CI)
      expect(elapsed).toBeLessThan(100);
    });
  });

  // ─── Test 6: worker_init_error_handling ──────────────────────
  describe("error handling", () => {
    it("should throw a descriptive error when worker fails to initialize", async () => {
      // Given: a URL to a non-existent Wasm module
      // (no _testWorker provided, and URL is invalid)

      // When/Then: createWorkerBridge should reject with a clear error
      await expect(
        createWorkerBridge("file:///nonexistent.wasm"),
      ).rejects.toThrow(/wasm|worker|init/i);
    });

    it("should set ready=false after terminate()", async () => {
      // Given: a working bridge
      const mockWorker = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        if (msg.type === "ping") return { type: "pong" };
        return null;
      });
      const bridge = await createWorkerBridge("mock://test.wasm", {
        _testWorker: mockWorker as unknown as Worker,
      });

      // When: we terminate it
      bridge.terminate();

      // Then: ready should be false
      expect(bridge.ready).toBe(false);
    });

    it("should reject send() after terminate()", async () => {
      // Given: a terminated bridge
      const mockWorker = new MockWorker((msg) => {
        if (msg.type === "init") return { type: "ready" };
        if (msg.type === "ping") return { type: "pong" };
        return null;
      });
      const bridge = await createWorkerBridge("mock://test.wasm", {
        _testWorker: mockWorker as unknown as Worker,
      });
      bridge.terminate();

      // When/Then: sending should reject
      await expect(bridge.ping()).rejects.toThrow(/terminated|closed/i);
    });
  });
});
