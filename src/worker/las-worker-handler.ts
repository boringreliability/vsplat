/**
 * Ward 026 — modtagersiden af Ward 21's LAS/LAZ worker-protokol.
 *
 * Ward 21 skrev `LasBridge` mod en protokol der aldrig fik en modtager:
 * `las-begin`/`las-chunk`/`las-end` blev postet ud i ingenting, og bridgen var
 * kun testet mod en mock. Det her er den anden ende.
 *
 * Handleren er en ren funktion frem for et direkte `self.onmessage`, så den kan
 * testes uden en rigtig Worker. `wasm-worker.ts` binder den til `self`.
 */

/** Den del af Wasm-FFI'en (Ward 21 + 25) som handleren bruger. */
export interface LasWasmModule {
  memory: WebAssembly.Memory;
  las_init(): void;
  las_parse_chunk(data: Uint8Array): number;
  las_point_count(): number;
  las_compressed(): boolean;
  las_positions_ptr(): number;
  las_positions_len(): number;
  las_intensity_ptr(): number;
  las_intensity_len(): number;
  las_rgb_ptr(): number;
  las_rgb_len(): number;
  las_classification_ptr(): number;
  las_classification_len(): number;
}

export type PostMessage = (msg: unknown, transfer?: Transferable[]) => void;

interface BeginMsg { type: "las-begin"; totalBytes: number; chunkSize: number }
interface ChunkMsg { type: "las-chunk"; chunk: ArrayBuffer }
interface SimpleMsg { type: "las-end" | "las-get-buffers" }
type Incoming = BeginMsg | ChunkMsg | SimpleMsg;

/**
 * Kopiér ud af Wasm-memory frem for at sende views.
 *
 * Ward 22 brændte sig på det: en view over Wasm-heapen detacher når heapen
 * vokser, og et view kan under alle omstændigheder ikke transfereres til main
 * thread. Kopien er prisen for at buffers overlever turen.
 */
function copyOut<T extends Float32Array | Uint16Array | Uint8Array>(
  ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): T {
  // `slice()` giver en kopi af samme type — ingen binding til Wasm-heapen.
  return new ctor(memory.buffer, ptr, len).slice() as T;
}

export function createLasWorkerHandler(
  wasm: LasWasmModule,
  post: PostMessage,
): (msg: unknown) => void {
  let totalBytes = 0;
  let bytesProcessed = 0;
  /** Sat når en chunk har fejlet: en fejlet load må aldrig også melde success. */
  let failed = false;

  function fail(err: unknown): void {
    failed = true;
    post({ type: "las-error", message: err instanceof Error ? err.message : String(err) });
  }

  return function handle(raw: unknown): void {
    const msg = raw as Incoming;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "las-begin": {
        try {
          totalBytes = msg.totalBytes;
          bytesProcessed = 0;
          failed = false;
          wasm.las_init();
        } catch (err) { fail(err); }
        return;
      }

      case "las-chunk": {
        if (failed) return;
        try {
          const bytes = new Uint8Array(msg.chunk);
          const pointsAdded = wasm.las_parse_chunk(bytes);
          bytesProcessed += bytes.byteLength;
          post({
            type: "las-progress",
            bytesProcessed,
            totalBytes,
            pointsAdded,
          });
        } catch (err) { fail(err); }
        return;
      }

      case "las-end": {
        if (failed) return;
        try {
          post({
            type: "las-loaded",
            pointCount: wasm.las_point_count(),
            hasRgb: wasm.las_rgb_len() > 0,
            hasClassification: wasm.las_classification_len() > 0,
            // Ward 25: UI'en skal kunne vise at filen var komprimeret
            compressed: wasm.las_compressed(),
          });
        } catch (err) { fail(err); }
        return;
      }

      case "las-get-buffers": {
        if (failed) return;
        try {
          const { memory } = wasm;
          const positions = copyOut(Float32Array, memory, wasm.las_positions_ptr(), wasm.las_positions_len());
          const intensity = copyOut(Uint16Array, memory, wasm.las_intensity_ptr(), wasm.las_intensity_len());
          const rgb = copyOut(Uint8Array, memory, wasm.las_rgb_ptr(), wasm.las_rgb_len());
          const classification = copyOut(Uint8Array, memory, wasm.las_classification_ptr(), wasm.las_classification_len());
          post(
            { type: "las-buffers", positions, intensity, rgb, classification },
            [positions.buffer, intensity.buffer, rgb.buffer, classification.buffer],
          );
        } catch (err) { fail(err); }
        return;
      }
    }
  };
}
