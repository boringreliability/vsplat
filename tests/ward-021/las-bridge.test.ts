/**
 * Ward 021 — LAS Worker Bridge tests (T9 + supplementary contract tests).
 *
 * T9 i specifikationen: worker emits progress events per chunk.
 *
 * Vi mocker Worker så testene kan køre i Node uden en faktisk Wasm-worker.
 * Den faktiske parser-logik er testet i `cargo test` (T1-T8).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLasBridge,
  type LasBridge,
  type LasProgress,
} from "../../src/worker/las-bridge.js";

// ─── Worker Mock ─────────────────────────────────────────────────

class MockWorker implements Worker {
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;

  /** Captured outbound messages — for assertions */
  posted: unknown[] = [];

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    const fn = typeof cb === "function" ? cb : cb.handleEvent.bind(cb);
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn as (e: MessageEvent) => void);
    this.listeners.set(type, arr);
  }

  removeEventListener(): void { /* not needed for tests */ }
  dispatchEvent(): boolean { return true; }
  terminate(): void { /* no-op */ }

  /** Test helper: simulate worker → main message */
  fire(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const fn of this.listeners.get("message") ?? []) {
      fn(event);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Build a minimal v1.2 LAS file with N PDRF 0 records — exact bytes don't need to be valid for bridge-side test. */
function makeFakeLas(numPoints: number): ArrayBuffer {
  const headerSize = 227;
  const recordLen = 20;
  const total = headerSize + numPoints * recordLen;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  // Magic
  view.setUint8(0, 0x4c); view.setUint8(1, 0x41); view.setUint8(2, 0x53); view.setUint8(3, 0x46);
  view.setUint8(24, 1); view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint8(104, 0); // PDRF 0
  view.setUint16(105, recordLen, true);
  view.setUint32(107, numPoints, true);
  return buf;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Ward 021: LAS Worker Bridge", () => {
  let worker: MockWorker;

  beforeEach(() => {
    worker = new MockWorker();
  });

  // ─── T9: worker_emits_progress_events ─────────────────────────

  it("T9: Given: en LAS-fil deles op i chunks — When: loadLas streames — Then: onProgress fyres mindst én gang per chunk", async () => {
    // Given: 10K points → ~200KB med chunkSize=64KB skal give ~4 chunks
    const bridge: LasBridge = await createLasBridge({
      worker,
      chunkSize: 64 * 1024,
    });
    const data = makeFakeLas(10_000);
    const progressEvents: LasProgress[] = [];

    // When: loadLas kører med onProgress callback
    const loadPromise = bridge.loadLas(data, (p) => progressEvents.push(p));

    // Simulér worker-respons med flere progress-events.
    // `setTimeout(0)` (i stedet for queueMicrotask) sikrer at loadLas's interne
    // postMessage-loop er færdig før vi fyrer worker→main events. Microtask ville
    // race med async setup.
    setTimeout(() => {
      worker.fire({ type: "las-progress", bytesProcessed: 64 * 1024, totalBytes: data.byteLength, pointsAdded: 3200 });
      worker.fire({ type: "las-progress", bytesProcessed: 128 * 1024, totalBytes: data.byteLength, pointsAdded: 6400 });
      worker.fire({ type: "las-progress", bytesProcessed: data.byteLength, totalBytes: data.byteLength, pointsAdded: 10_000 });
      worker.fire({ type: "las-loaded", pointCount: 10_000, hasRgb: false, hasClassification: true });
    }, 0);

    await loadPromise;

    // Then: progress-events er modtaget i monoton-stigende rækkefølge
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < progressEvents.length; i++) {
      expect(progressEvents[i]!.bytesProcessed).toBeGreaterThanOrEqual(progressEvents[i - 1]!.bytesProcessed);
      expect(progressEvents[i]!.pointsAdded).toBeGreaterThanOrEqual(progressEvents[i - 1]!.pointsAdded);
    }
    // Sidste progress når totalBytes
    const last = progressEvents.at(-1)!;
    expect(last.bytesProcessed).toBe(data.byteLength);

    // Verificér chunked streaming-adfærd: bridgen skal poste flere chunks,
    // ikke ét enkelt fullBuffer-message. Uden denne assertion ville en impl
    // der sender data som én klump bestå T9 ved tilfældighed.
    expect(worker.posted.length).toBeGreaterThanOrEqual(2);
  });

  it("T9b: Given: loadLas uden onProgress callback — When: parser sender progress-events — Then: ingen exception (callback er optional)", async () => {
    const bridge: LasBridge = await createLasBridge({ worker, chunkSize: 64 * 1024 });
    const data = makeFakeLas(1000);

    const loadPromise = bridge.loadLas(data); // no callback

    setTimeout(() => {
      worker.fire({ type: "las-progress", bytesProcessed: 1024, totalBytes: data.byteLength, pointsAdded: 50 });
      worker.fire({ type: "las-loaded", pointCount: 1000, hasRgb: false, hasClassification: true });
    }, 0);

    // Then: resolves med fuld kontrakt — ikke kun pointCount
    await expect(loadPromise).resolves.toMatchObject({
      pointCount: 1000,
      hasRgb: false,
      hasClassification: true,
    });
  });
});
