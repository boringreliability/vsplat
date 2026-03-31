/**
 * JS ↔ Wasm Worker message bridge.
 * Typed message protocol for communication between main thread and Rust Worker.
 */

export type WorkerMessageType = "ping" | "pong" | "error" | "init" | "ready";

export interface WorkerMessage {
  type: WorkerMessageType;
  payload?: unknown;
}

export interface WorkerBridge {
  /** Send a message to the worker and await a response */
  send(msg: WorkerMessage): Promise<WorkerMessage>;
  /** Send ping and expect pong back */
  ping(): Promise<"pong">;
  /** Terminate the worker */
  terminate(): void;
  /** Whether the worker is ready */
  readonly ready: boolean;
}

export interface WorkerBridgeOptions {
  /** Inject a test worker (for unit testing without real Wasm) */
  _testWorker?: Worker;
}

export async function createWorkerBridge(
  wasmUrl: string | URL,
  options?: WorkerBridgeOptions,
): Promise<WorkerBridge> {
  const worker = options?._testWorker ?? createWorker(wasmUrl);

  let _ready = true;
  const queue: Array<{
    resolve: (msg: WorkerMessage) => void;
    reject: (err: Error) => void;
  }> = [];

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const entry = queue.shift();
    if (entry) {
      entry.resolve(event.data);
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    for (const entry of queue) {
      entry.reject(new Error(event.message ?? "Worker error"));
    }
    queue.length = 0;
  };

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
  throw new Error(`Failed to initialize Wasm worker from ${wasmUrl}`);
}
