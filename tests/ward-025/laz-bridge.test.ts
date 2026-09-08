/**
 * Ward 025 — T6: worker_bridge_handles_laz_seamlessly.
 *
 * Kontrakten er at LAZ og LAS deler præcis den samme vej gennem bridgen:
 * ingen separat `loadLaz()`, ingen format-sniffing på JS-siden, ingen
 * rekomprimering. Bridgen er ren transport — decoderen lever i Rust (Ward 25's
 * strategi #1), så det eneste JS skal vide er *at* filen var komprimeret, så
 * UI kan vise det.
 *
 * Selve decode-korrektheden er dækket af `cargo test` (T1-T5).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLasBridge, type LasBridge } from "../../src/worker/las-bridge.js";

// ─── Worker Mock ─────────────────────────────────────────────────

class MockWorker implements Worker {
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;

  posted: any[] = [];

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

  fire(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const fn of this.listeners.get("message") ?? []) fn(event);
  }

  /** Alle "las-chunk"-payloads samlet igen i original rækkefølge. */
  reassembleChunks(): Uint8Array {
    const chunks = this.posted
      .filter((m) => m?.type === "las-chunk")
      .map((m) => new Uint8Array(m.chunk as ArrayBuffer));
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return out;
  }
}

// ─── Fixture ─────────────────────────────────────────────────────

/**
 * Samme LASzip-komprimerede fixture som Rust-testene bruger. Vi læser den
 * rigtige fil frem for at fabrikere bytes — pointen med T6 er netop at
 * bridgen ikke må behandle ægte komprimeret indhold anderledes end LAS.
 */
const FIXTURES = new URL("../../crates/vsplat-core/tests/fixtures/", import.meta.url);
function fixture(name: string): ArrayBuffer {
  const buf = readFileSync(fileURLToPath(new URL(name, FIXTURES)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("Ward 025 — LAZ through the worker bridge", () => {
  let worker: MockWorker;
  let bridge: LasBridge;

  beforeEach(async () => {
    worker = new MockWorker();
    bridge = await createLasBridge({ worker, chunkSize: 4096 });
  });

  it("T6: worker_bridge_handles_laz_seamlessly", async () => {
    const laz = fixture("pdrf3_v12.laz");
    expect(laz.byteLength).toBeGreaterThan(0);
    // Sanity: fixturen ER komprimeret (high bit på point_data_format @ offset 104)
    expect(new Uint8Array(laz)[104] & 0x80).toBe(0x80);

    const load = bridge.loadLas(laz);

    // Bridgen streamer den komprimerede fil ubeskåret videre — samme
    // besked-protokol som LAS, ingen ekstra beskedtyper, intet frasorteret.
    const types = worker.posted.map((m) => m.type);
    expect(types[0]).toBe("las-begin");
    expect(types.at(-1)).toBe("las-end");
    expect(new Set(types)).toEqual(new Set(["las-begin", "las-chunk", "las-end"]));

    // Bytes ud = bytes ind, bit for bit. En JS-side "hjælpsom" transformation
    // (dekomprimering, header-rewrite) ville ødelægge LAZ-streamen.
    const forwarded = worker.reassembleChunks();
    expect(forwarded).toEqual(new Uint8Array(laz));

    // Worker melder tilbage at filen var komprimeret, så UI kan vise "LAZ".
    worker.fire({
      type: "las-loaded",
      pointCount: 1000,
      hasRgb: true,
      hasClassification: true,
      compressed: true,
    });

    const result = await load;
    expect(result.pointCount).toBe(1000);
    expect(result.hasRgb).toBe(true);
    expect(result.compressed).toBe(true);
  });

  it("T6b: en ukomprimeret LAS rapporteres som ikke-komprimeret", async () => {
    const las = fixture("pdrf3_v12.las");
    expect(new Uint8Array(las)[104] & 0x80).toBe(0);

    const load = bridge.loadLas(las);
    worker.fire({
      type: "las-loaded",
      pointCount: 1000,
      hasRgb: true,
      hasClassification: true,
      compressed: false,
    });

    expect((await load).compressed).toBe(false);
  });
});
