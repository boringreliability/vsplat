/**
 * Chunked export streaming: writes PLY header + binary data to a sink in batches.
 *
 * High-performance Batched Streaming: Never holds more than one batch of splats in memory at a time.
 * Iterates over splats in batches, serializes each batch to a small temporary
 * buffer, and writes it to the sink immediately.
 *
 * ExportSink abstraction allows writing to OPFS, in-memory buffer, or any target.
 * sink.close() is called exactly once at the end.
 */

import {
  generatePlyHeader,
  countActive,
  computeStride,
  readProperty,
  writeProperty,
  type PropertyDef,
} from "./ply-writer.js";

/** Sink interface for chunked export output. */
export interface ExportSink {
  write(chunk: ArrayBuffer): void;
  close(): void;
}

const DELETED = 0x04;

/**
 * Export splats to a sink in batches with progress reporting.
 *
 * High-performance Batched Streaming pipeline — never holds full binary in memory:
 *   1. Generate and write PLY header as first chunk
 *   2. Iterate over splats in batches of `chunkSize / stride` splats
 *   3. For each batch: serialize to a small temp buffer, write to sink
 *   4. Fire progress callback after each batch (monotonically increasing, ends at 1.0)
 *   5. Call sink.close() exactly once
 *
 * @param properties PLY property definitions
 * @param data Splat data arrays
 * @param visibility Per-splat visibility flags
 * @param sink Output destination
 * @param chunkSize Approximate bytes per chunk (default 4MB). Actual chunks
 *   are rounded to whole splats (stride-aligned).
 * @param onProgress Optional callback with progress in [0, 1]
 * @throws If chunkSize <= 0
 */
export function exportChunked(
  properties: PropertyDef[],
  data: { positions: Float32Array; opacities: Float32Array; [key: string]: Float32Array },
  visibility: Uint8Array,
  sink: ExportSink,
  chunkSize: number = 4 * 1024 * 1024,
  onProgress?: (progress: number) => void,
): void {
  if (chunkSize <= 0) {
    throw new Error(`chunkSize must be > 0, got ${chunkSize}`);
  }

  // Step 1: Write header (slice to get exact-sized buffer — TextEncoder may over-allocate)
  const header = generatePlyHeader(properties, visibility);
  const headerBytes = new TextEncoder().encode(header);
  sink.write(headerBytes.slice().buffer);

  const totalActive = countActive(visibility);

  // Handle empty export (all deleted)
  if (totalActive === 0) {
    onProgress?.(1.0);
    sink.close();
    return;
  }

  // Step 2: Stream splats in batches
  const stride = computeStride(properties);
  const splatsPerBatch = Math.max(1, Math.floor(chunkSize / stride));
  const totalSplats = visibility.length;

  // Reusable batch buffer — only ONE allocation, reused across batches
  const batchBuffer = new ArrayBuffer(splatsPerBatch * stride);
  const batchView = new DataView(batchBuffer);

  let writtenActive = 0;
  let batchCount = 0;
  let batchOffset = 0;

  for (let i = 0; i < totalSplats; i++) {
    if (visibility[i] & DELETED) continue;

    // Serialize one splat into the batch buffer
    for (const prop of properties) {
      const val = readProperty(prop.name, i, data);
      batchOffset += writeProperty(batchView, batchOffset, prop, val);
    }

    batchCount++;
    writtenActive++;

    // Flush batch when full
    if (batchCount >= splatsPerBatch) {
      sink.write(batchBuffer.slice(0, batchOffset));
      batchOffset = 0;
      batchCount = 0;
      onProgress?.(Math.min(writtenActive / totalActive, 1.0));
    }
  }

  // Flush remaining partial batch
  if (batchCount > 0) {
    sink.write(batchBuffer.slice(0, batchOffset));
  }

  // Final progress
  onProgress?.(1.0);

  // Step 5: Close sink exactly once
  sink.close();
}
