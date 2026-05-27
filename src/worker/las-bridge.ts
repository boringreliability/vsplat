/**
 * Ward 021: LAS Worker Bridge.
 *
 * Streamer en LAS-fil til Wasm-parseren chunk-for-chunk og rapporterer progress
 * tilbage til main thread. Eksponerer SoA-buffers (positions, intensity, rgb,
 * classification) som zero-copy views over Wasm-memory efter load er complete.
 */

export interface LasProgress {
  bytesProcessed: number;
  totalBytes: number;
  pointsAdded: number;
}

export interface LasLoadResult {
  pointCount: number;
  hasRgb: boolean;
  hasClassification: boolean;
}

export interface LasBuffers {
  positions: Float32Array;
  intensity: Uint16Array;
  rgb: Uint8Array;
  classification: Uint8Array;
}

export interface LasBridge {
  loadLas(
    data: ArrayBuffer,
    onProgress?: (p: LasProgress) => void,
  ): Promise<LasLoadResult>;
  getBuffers(): Promise<LasBuffers>;
  terminate(): void;
}

export interface LasBridgeOptions {
  worker?: Worker;
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 64 * 1024;

interface ProgressMsg { type: "las-progress"; bytesProcessed: number; totalBytes: number; pointsAdded: number; }
interface LoadedMsg { type: "las-loaded"; pointCount: number; hasRgb: boolean; hasClassification: boolean; }
interface BuffersMsg {
  type: "las-buffers";
  positions: Float32Array;
  intensity: Uint16Array;
  rgb: Uint8Array;
  classification: Uint8Array;
}
interface ErrorMsg { type: "las-error"; message: string; }
type WorkerMsg = ProgressMsg | LoadedMsg | BuffersMsg | ErrorMsg;

export async function createLasBridge(
  options?: LasBridgeOptions,
): Promise<LasBridge> {
  const worker = options?.worker;
  if (!worker) {
    throw new Error("LasBridge requires an injected Worker — real Worker spawn is not yet wired");
  }
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

  // Single-flight: bridgen håndterer én load ad gangen
  let activeOnProgress: ((p: LasProgress) => void) | null = null;
  let resolveLoad: ((r: LasLoadResult) => void) | null = null;
  let rejectLoad: ((e: Error) => void) | null = null;
  let resolveBuffers: ((b: LasBuffers) => void) | null = null;
  let pendingBuffers: LasBuffers | null = null;

  worker.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as WorkerMsg;
    switch (msg.type) {
      case "las-progress":
        activeOnProgress?.({
          bytesProcessed: msg.bytesProcessed,
          totalBytes: msg.totalBytes,
          pointsAdded: msg.pointsAdded,
        });
        break;
      case "las-loaded":
        resolveLoad?.({
          pointCount: msg.pointCount,
          hasRgb: msg.hasRgb,
          hasClassification: msg.hasClassification,
        });
        resolveLoad = null;
        rejectLoad = null;
        activeOnProgress = null;
        break;
      case "las-buffers":
        pendingBuffers = {
          positions: msg.positions,
          intensity: msg.intensity,
          rgb: msg.rgb,
          classification: msg.classification,
        };
        resolveBuffers?.(pendingBuffers);
        resolveBuffers = null;
        break;
      case "las-error":
        rejectLoad?.(new Error(msg.message));
        resolveLoad = null;
        rejectLoad = null;
        activeOnProgress = null;
        break;
    }
  });

  return {
    async loadLas(data, onProgress) {
      return new Promise<LasLoadResult>((resolve, reject) => {
        activeOnProgress = onProgress ?? null;
        resolveLoad = resolve;
        rejectLoad = reject;
        // Send chunks. Bridgen poster mindst to messages (start + ≥1 chunk)
        // så worker.posted-listen reflekterer chunked streaming.
        worker.postMessage({ type: "las-begin", totalBytes: data.byteLength, chunkSize });
        const total = data.byteLength;
        let offset = 0;
        while (offset < total) {
          const end = Math.min(offset + chunkSize, total);
          // Slice() kopierer; det er nødvendigt fordi Transferable kun virker én gang
          // og vi vil ikke neutralisere caller's buffer. For prod-LiDAR-størrelse er
          // dette OK fordi parsing er ~100x dyrere end memcpy.
          const chunk = data.slice(offset, end);
          worker.postMessage({ type: "las-chunk", chunk }, [chunk]);
          offset = end;
        }
        worker.postMessage({ type: "las-end" });
      });
    },
    async getBuffers() {
      if (pendingBuffers) return pendingBuffers;
      return new Promise<LasBuffers>((resolve) => {
        resolveBuffers = resolve;
        worker.postMessage({ type: "las-get-buffers" });
      });
    },
    terminate() {
      worker.terminate();
      activeOnProgress = null;
      resolveLoad = null;
      rejectLoad = null;
      resolveBuffers = null;
      pendingBuffers = null;
    },
  };
}
