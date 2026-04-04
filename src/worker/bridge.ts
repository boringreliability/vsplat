/**
 * JS ↔ Wasm Worker message bridge.
 * Typed message protocol for communication between main thread and Rust Worker.
 *
 * Ward 15: Updated with init handshake timeout, loadPly with transfer,
 * getBuffers with Float32Array wrapping, and error propagation.
 * Backward compatible with Ward 1 ping/pong contract.
 */

export type WorkerMessageType =
  | "ping" | "pong"
  | "init" | "ready"
  | "load" | "loaded"
  | "query-buffers" | "buffers"
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

export interface WorkerBridge {
  send(msg: WorkerMessage): Promise<WorkerMessage>;
  ping(): Promise<"pong">;
  loadPly(data: ArrayBuffer): Promise<{ splatCount: number }>;
  getBuffers(): Promise<SplatBuffers>;
  terminate(): void;
  readonly ready: boolean;
}

export interface WorkerBridgeOptions {
  _testWorker?: Worker;
  _initTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT = 10_000;

export async function createWorkerBridge(
  wasmUrl: string | URL,
  options?: WorkerBridgeOptions,
): Promise<WorkerBridge> {
  const worker = options?._testWorker ?? createWorker(wasmUrl);
  const initTimeout = options?._initTimeoutMs ?? DEFAULT_INIT_TIMEOUT;

  let _ready = false;
  const queue: Array<{
    resolve: (msg: WorkerMessage) => void;
    reject: (err: Error) => void;
  }> = [];

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const entry = queue.shift();
    if (entry) {
      // Error responses from worker reject the pending promise
      if (event.data.type === "error") {
        entry.reject(new Error(String(event.data.message ?? "Worker error")));
      } else {
        entry.resolve(event.data);
      }
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    for (const entry of queue) {
      entry.reject(new Error(event.message ?? "Worker error"));
    }
    queue.length = 0;
  };

  // Init handshake with timeout
  const initPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Worker init timeout after ${initTimeout}ms for ${wasmUrl}`,
      ));
    }, initTimeout);

    queue.push({
      resolve: (msg) => {
        clearTimeout(timer);
        if (msg.type === "ready") {
          _ready = true;
          resolve();
        } else {
          reject(new Error(`Expected 'ready', got '${msg.type}'`));
        }
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    worker.postMessage({ type: "init", wasmUrl: String(wasmUrl) });
  });

  await initPromise;

  const bridge: WorkerBridge = {
    get ready() {
      return _ready;
    },

    async send(msg: WorkerMessage): Promise<WorkerMessage> {
      if (!_ready) {
        throw new Error("Worker terminated");
      }
      return new Promise<WorkerMessage>((resolve, reject) => {
        queue.push({ resolve, reject });
        worker.postMessage(msg);
      });
    },

    async ping(): Promise<"pong"> {
      const response = await this.send({ type: "ping" });
      if (response.type !== "pong") {
        throw new Error(`Expected pong, got ${response.type}`);
      }
      return "pong";
    },

    async loadPly(data: ArrayBuffer): Promise<{ splatCount: number }> {
      if (!_ready) {
        throw new Error("Worker terminated");
      }
      return new Promise<{ splatCount: number }>((resolve, reject) => {
        queue.push({
          resolve: (msg) => {
            resolve({ splatCount: msg.splatCount as number });
          },
          reject,
        });
        worker.postMessage({ type: "load", plyData: data }, [data] as Transferable[]);
      });
    },

    async getBuffers(): Promise<SplatBuffers> {
      if (!_ready) {
        throw new Error("Worker terminated");
      }
      return new Promise<SplatBuffers>((resolve, reject) => {
        queue.push({
          resolve: (msg) => {
            resolve({
              positions: new Float32Array(msg.positions as ArrayBuffer),
              rotations: new Float32Array(msg.rotations as ArrayBuffer),
              scales: new Float32Array(msg.scales as ArrayBuffer),
              opacities: new Float32Array(msg.opacities as ArrayBuffer),
              sh: new Float32Array(msg.sh as ArrayBuffer),
              shDim: msg.shDim as number,
              splatCount: msg.splatCount as number,
            });
          },
          reject,
        });
        worker.postMessage({ type: "query-buffers" });
      });
    },

    terminate(): void {
      _ready = false;
      for (const entry of queue) {
        entry.reject(new Error("Worker terminated"));
      }
      queue.length = 0;
      worker.terminate();
    },
  };

  return bridge;
}

function createWorker(wasmUrl: string | URL): Worker {
  // Ward 15: real Worker instantiation (wasm-worker.ts bundled as Worker script)
  // For now, the Worker URL is derived from the Wasm URL's base path.
  // In production, this will point to the bundled wasm-worker.js.
  const workerUrl = new URL("./wasm-worker.js", wasmUrl);
  return new Worker(workerUrl, { type: "module" });
}
