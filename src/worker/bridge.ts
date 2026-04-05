/**
 * JS ↔ Wasm Worker message bridge.
 * Typed message protocol for communication between main thread and Rust Worker.
 *
 * Ward 15: Init handshake, loadPly, getBuffers, error propagation.
 * Ward 17: Per-operation timeouts, structured config, late reply handling.
 *          All errors are VsplatError (structured, not raw Error).
 */

import { createVsplatError } from "../errors/vsplat-error.js";

export type WorkerMessageType =
  | "ping" | "pong"
  | "init" | "ready"
  | "load" | "loaded"
  | "query-buffers" | "buffers"
  | "sort" | "sorted"
  | "error";

export interface WorkerMessage {
  type: WorkerMessageType;
  [key: string]: unknown;
}

export interface SplatBuffers {
  positions: Float32Array;
  rotations: Float32Array;
  scales: Float32Array;
  opacities: Float32Array;
  sh: Float32Array;
  shDim: number;
  splatCount: number;
}

export interface BridgeTimeouts {
  init: number;
  loadPly: number;
  getBuffers: number;
  ping: number;
}

export interface WorkerBridge {
  send(msg: WorkerMessage): Promise<WorkerMessage>;
  ping(): Promise<"pong">;
  loadPly(data: ArrayBuffer): Promise<{ splatCount: number }>;
  getBuffers(): Promise<SplatBuffers>;
  sortByDepth(camX: number, camY: number, camZ: number, dirX: number, dirY: number, dirZ: number): Promise<Uint32Array>;
  terminate(): void;
  readonly ready: boolean;
}

export interface WorkerBridgeOptions {
  /** Injected Worker (for testing). If omitted, creates real Worker from URL. */
  worker?: Worker;
  /** Per-operation timeouts in milliseconds. */
  timeouts?: Partial<BridgeTimeouts>;

  // Ward 1 legacy compat (deprecated — use worker + timeouts instead)
  _testWorker?: Worker;
  _initTimeoutMs?: number;
  _operationTimeoutMs?: number;
}

const DEFAULT_TIMEOUTS: BridgeTimeouts = {
  init: 10_000,
  loadPly: 30_000,
  getBuffers: 10_000,
  ping: 5_000,
};

export async function createWorkerBridge(
  wasmUrl: string | URL,
  options?: WorkerBridgeOptions,
): Promise<WorkerBridge> {
  // Resolve config: new style takes precedence over legacy
  const worker = options?.worker ?? options?._testWorker ?? createWorker(wasmUrl);
  const timeouts: BridgeTimeouts = {
    init: options?.timeouts?.init ?? options?._initTimeoutMs ?? DEFAULT_TIMEOUTS.init,
    loadPly: options?.timeouts?.loadPly ?? options?._operationTimeoutMs ?? DEFAULT_TIMEOUTS.loadPly,
    getBuffers: options?.timeouts?.getBuffers ?? options?._operationTimeoutMs ?? DEFAULT_TIMEOUTS.getBuffers,
    ping: options?.timeouts?.ping ?? options?._operationTimeoutMs ?? DEFAULT_TIMEOUTS.ping,
  };

  let _ready = false;
  const queue: Array<{
    resolve: (msg: WorkerMessage) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const entry = queue.shift();
    if (!entry) return; // late reply after timeout — silently dropped
    if (entry.timer) clearTimeout(entry.timer);
    if (event.data.type === "error") {
      entry.reject(createVsplatError("LOAD_FAILED", { details: String(event.data.message ?? "Worker error") }));
    } else {
      entry.resolve(event.data);
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    _ready = false;
    for (const entry of queue) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(createVsplatError("WORKER_CRASHED", { details: event.message ?? "Worker crashed" }));
    }
    queue.length = 0;
  };

  // Helper: send with timeout
  function sendWithTimeout(msg: WorkerMessage, timeoutMs: number, opName: string): Promise<WorkerMessage> {
    if (!_ready) {
      return Promise.reject(createVsplatError("BRIDGE_TIMEOUT", { details: "Worker terminated" }));
    }
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this entry from queue (late reply will be dropped by onmessage)
        const idx = queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) queue.splice(idx, 1);
        reject(createVsplatError("BRIDGE_TIMEOUT", { details: `${opName} did not respond within ${timeoutMs}ms` }));
      }, timeoutMs);

      queue.push({ resolve, reject, timer });
      worker.postMessage(msg);
    });
  }

  // Helper: send with timeout + transfer
  function sendWithTransfer(
    msg: WorkerMessage, transfer: Transferable[], timeoutMs: number, opName: string,
  ): Promise<WorkerMessage> {
    if (!_ready) {
      return Promise.reject(createVsplatError("BRIDGE_TIMEOUT", { details: "Worker terminated" }));
    }
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) queue.splice(idx, 1);
        reject(createVsplatError("BRIDGE_TIMEOUT", { details: `${opName} did not respond within ${timeoutMs}ms` }));
      }, timeoutMs);

      queue.push({ resolve, reject, timer });
      worker.postMessage(msg, transfer as Transferable[]);
    });
  }

  // Init handshake with timeout
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createVsplatError("BRIDGE_TIMEOUT", { details: `init did not respond within ${timeouts.init}ms for ${wasmUrl}` }));
    }, timeouts.init);

    queue.push({
      resolve: (msg) => {
        clearTimeout(timer);
        if (msg.type === "ready") {
          _ready = true;
          resolve();
        } else {
          reject(createVsplatError("BRIDGE_TIMEOUT", { details: `Expected 'ready', got '${msg.type}'` }));
        }
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      timer,
    });

    worker.postMessage({ type: "init", wasmUrl: String(wasmUrl) });
  });

  const bridge: WorkerBridge = {
    get ready() {
      return _ready;
    },

    async send(msg: WorkerMessage): Promise<WorkerMessage> {
      return sendWithTimeout(msg, timeouts.ping, msg.type);
    },

    async ping(): Promise<"pong"> {
      const response = await sendWithTimeout({ type: "ping" }, timeouts.ping, "ping");
      if (response.type !== "pong") {
        throw createVsplatError("BRIDGE_TIMEOUT", { details: `Expected pong, got ${response.type}` });
      }
      return "pong";
    },

    async loadPly(data: ArrayBuffer): Promise<{ splatCount: number }> {
      const response = await sendWithTransfer(
        { type: "load", plyData: data }, [data], timeouts.loadPly, "loadPly",
      );
      return { splatCount: response.splatCount as number };
    },

    async getBuffers(): Promise<SplatBuffers> {
      const msg = await sendWithTimeout({ type: "query-buffers" }, timeouts.getBuffers, "getBuffers");
      return {
        positions: new Float32Array(msg.positions as ArrayBuffer),
        rotations: new Float32Array(msg.rotations as ArrayBuffer),
        scales: new Float32Array(msg.scales as ArrayBuffer),
        opacities: new Float32Array(msg.opacities as ArrayBuffer),
        sh: new Float32Array(msg.sh as ArrayBuffer),
        shDim: msg.shDim as number,
        splatCount: msg.splatCount as number,
      };
    },

    async sortByDepth(camX: number, camY: number, camZ: number, dirX: number, dirY: number, dirZ: number): Promise<Uint32Array> {
      const msg = await sendWithTimeout(
        { type: "sort", camX, camY, camZ, dirX, dirY, dirZ }, timeouts.getBuffers, "sortByDepth",
      );
      return new Uint32Array(msg.sortedIndices as ArrayBuffer);
    },

    terminate(): void {
      _ready = false;
      for (const entry of queue) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(createVsplatError("BRIDGE_TIMEOUT", { details: "Worker terminated" }));
      }
      queue.length = 0;
      worker.terminate();
    },
  };

  return bridge;
}

function createWorker(wasmUrl: string | URL): Worker {
  const workerUrl = new URL("./wasm-worker.js", wasmUrl);
  return new Worker(workerUrl, { type: "module" });
}
