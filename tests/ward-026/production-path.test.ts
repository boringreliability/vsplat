/**
 * Ward 026 — LiDAR Production Path.
 *
 * Ward 21 skrev `LasBridge` mod en worker-protokol der aldrig fik en modtager,
 * og `checkSceneMemory` regner med 3DGS-footprint for alt. Begge dele står
 * mellem motoren og en app der kan åbne en 20M-punkts LAZ. Testene her låser
 * modtagersiden, det format-bevidste memory-estimat, format-detektionen og
 * kravet om at filen aldrig samles i en JS ArrayBuffer.
 *
 * Alt kører uden GPU. Selve renderingen verificeres af V1-V4 i browseren.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createLasWorkerHandler,
  type LasWasmModule,
} from "../../src/worker/las-worker-handler.js";
import { estimateSceneMemory, checkSceneMemory } from "../../src/errors/memory-pressure.js";
import { detectSceneFormat } from "../../src/app/scene-format.js";
import { computePointSize } from "../../src/render/point-size.js";
import { perspectiveMatrix } from "../../src/camera/math.js";
import { DEFAULT_RENDER_MODE, pipelineForRenderMode } from "../../src/app/render-mode.js";
import { loadSceneFile } from "../../src/app/scene-loader.js";

// ─── Fake Wasm-modul ─────────────────────────────────────────────

interface FakeOptions {
  pointCount?: number;
  hasRgb?: boolean;
  hasClassification?: boolean;
  compressed?: boolean;
  throwOnChunk?: number;
}

function makeFakeWasm(opts: FakeOptions = {}): LasWasmModule & {
  chunks: Uint8Array[];
  initCalls: number;
  memory: WebAssembly.Memory;
} {
  const pointCount = opts.pointCount ?? 3;
  // Ét minimalt heap-område som ptr/len-parrene peger ind i
  const memory = new WebAssembly.Memory({ initial: 1 });
  const state = {
    chunks: [] as Uint8Array[],
    initCalls: 0,
    memory,
    las_init() { state.initCalls++; state.chunks.length = 0; },
    las_parse_chunk(bytes: Uint8Array) {
      if (opts.throwOnChunk !== undefined && state.chunks.length === opts.throwOnChunk) {
        throw new Error("LazDecode(\"corrupt chunk table\")");
      }
      state.chunks.push(new Uint8Array(bytes));
      return pointCount;
    },
    las_point_count: () => pointCount,
    las_compressed: () => opts.compressed ?? false,
    las_positions_ptr: () => 0,
    las_positions_len: () => pointCount * 3,
    las_intensity_ptr: () => 256,
    las_intensity_len: () => pointCount,
    las_rgb_ptr: () => 512,
    las_rgb_len: () => (opts.hasRgb ?? true ? pointCount * 3 : 0),
    las_classification_ptr: () => 768,
    las_classification_len: () => (opts.hasClassification ?? true ? pointCount : 0),
  };
  return state;
}

function chunkMessages(count: number, size = 8): unknown[] {
  const msgs: unknown[] = [{ type: "las-begin", totalBytes: count * size, chunkSize: size }];
  for (let i = 0; i < count; i++) {
    msgs.push({ type: "las-chunk", chunk: new Uint8Array(size).fill(i).buffer });
  }
  msgs.push({ type: "las-end" });
  return msgs;
}

describe("Ward 026 — LiDAR Production Path", () => {
  // ─── T1 ────────────────────────────────────────────────────────

  it("T1: las_worker_handler_streams_chunks_to_parser", () => {
    const wasm = makeFakeWasm();
    const post = vi.fn();
    const handle = createLasWorkerHandler(wasm, post);

    for (const msg of chunkMessages(4)) handle(msg);

    // Parseren initialiseres én gang, og hver chunk når frem — i rækkefølge
    expect(wasm.initCalls).toBe(1);
    expect(wasm.chunks).toHaveLength(4);
    wasm.chunks.forEach((c, i) => expect(c[0]).toBe(i));

    // Progress rapporteres per chunk, med voksende bytesProcessed
    const progress = post.mock.calls
      .map(([m]) => m as { type: string; bytesProcessed: number; totalBytes: number })
      .filter((m) => m.type === "las-progress");
    expect(progress).toHaveLength(4);
    expect(progress.map((p) => p.bytesProcessed)).toEqual([8, 16, 24, 32]);
    expect(progress.at(-1)!.totalBytes).toBe(32);
  });

  // ─── T2 ────────────────────────────────────────────────────────

  it("T2: las_worker_handler_reports_load_result", () => {
    const wasm = makeFakeWasm({
      pointCount: 1234, hasRgb: true, hasClassification: true, compressed: true,
    });
    const post = vi.fn();
    const handle = createLasWorkerHandler(wasm, post);

    for (const msg of chunkMessages(2)) handle(msg);

    const loaded = post.mock.calls
      .map(([m]) => m as Record<string, unknown>)
      .find((m) => m.type === "las-loaded");
    expect(loaded).toBeDefined();
    expect(loaded).toMatchObject({
      type: "las-loaded",
      pointCount: 1234,
      hasRgb: true,
      hasClassification: true,
      compressed: true, // Ward 25: UI skal kunne vise at filen var LAZ
    });
  });

  // ─── T3 ────────────────────────────────────────────────────────

  it("T3: las_worker_handler_surfaces_parse_errors", () => {
    const wasm = makeFakeWasm({ throwOnChunk: 1 });
    const post = vi.fn();
    const handle = createLasWorkerHandler(wasm, post);

    for (const msg of chunkMessages(3)) handle(msg);

    const types = post.mock.calls.map(([m]) => (m as { type: string }).type);
    expect(types).toContain("las-error");
    // En fejlet load må ALDRIG også melde success
    expect(types).not.toContain("las-loaded");

    const error = post.mock.calls
      .map(([m]) => m as { type: string; message: string })
      .find((m) => m.type === "las-error")!;
    expect(error.message).toMatch(/LazDecode/);
  });

  // ─── T4 ────────────────────────────────────────────────────────

  it("T4: las_worker_handler_exposes_buffers", () => {
    const wasm = makeFakeWasm({ pointCount: 5 });
    const post = vi.fn();
    const handle = createLasWorkerHandler(wasm, post);

    for (const msg of chunkMessages(1)) handle(msg);
    handle({ type: "las-get-buffers" });

    const buffers = post.mock.calls
      .map(([m]) => m as Record<string, unknown>)
      .find((m) => m.type === "las-buffers")!;
    expect(buffers).toBeDefined();
    expect((buffers.positions as Float32Array).length).toBe(15);
    expect((buffers.intensity as Uint16Array).length).toBe(5);
    expect((buffers.rgb as Uint8Array).length).toBe(15);
    expect((buffers.classification as Uint8Array).length).toBe(5);
  });

  // ─── T5 ────────────────────────────────────────────────────────

  it("T5: memory_estimate_is_format_aware", () => {
    const count = 1_000_000;
    const splats = estimateSceneMemory(count, 0, "splats");
    const points = estimateSceneMemory(count, 0, "points");

    // Et LiDAR-punkt er ~19B SoA mod et splats ~236B input-stride alene
    expect(points).toBeLessThan(splats / 4);

    // Ward 17's kaldere sender ikke format — defaulten skal være uændret
    expect(estimateSceneMemory(count, 0)).toBe(splats);
  });

  // ─── T6 ────────────────────────────────────────────────────────

  it("T6: memory_gate_admits_20m_points_and_still_guards_splats", () => {
    const TWENTY_MILLION = 20_000_000;
    const THRESHOLD = 2 * 1024 * 1024 * 1024;

    // Epic 06's mål: 20M punkter skal kunne åbnes
    expect(checkSceneMemory(TWENTY_MILLION, 0, THRESHOLD, "points")).toBeNull();

    // ...uden at gaten holder op med at beskytte splat-stien
    const splatGate = checkSceneMemory(TWENTY_MILLION, 0, THRESHOLD, "splats");
    expect(splatGate).not.toBeNull();
    expect(splatGate!.code).toBe("SCENE_TOO_LARGE");
  });

  // ─── T7 ────────────────────────────────────────────────────────

  it("T7: scene_format_detected_from_magic_bytes", () => {
    const lasf = new Uint8Array([0x4c, 0x41, 0x53, 0x46, 0, 0, 0, 0]);
    const ply = new TextEncoder().encode("ply\nformat binary_little_endian 1.0\n");

    // Endelsen lyver: Ward 25 gør LAZ transparent, så begge er "las"
    expect(detectSceneFormat("scan.las", lasf)).toBe("las");
    expect(detectSceneFormat("scan.laz", lasf)).toBe("las");
    expect(detectSceneFormat("scan.bin", lasf)).toBe("las");

    expect(detectSceneFormat("cloud.ply", ply)).toBe("ply");

    // Skrald skal afvises, ikke gættes
    expect(detectSceneFormat("mystery.las", new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  // ─── T8 ────────────────────────────────────────────────────────

  it("T8: perspective_camera_makes_point_size_depth_dependent", () => {
    const proj = perspectiveMatrix(Math.PI / 4, 16 / 9, 0.1, 1000);

    // Column-major: w' = m[3]·x + m[7]·y + m[11]·z + m[15].
    // Punktet er allerede i view space, kameraet kigger ned ad -Z.
    const clipW = (z: number): number => proj[3]! * 0 + proj[7]! * 0 + proj[11]! * z + proj[15]!;

    const near = Math.abs(clipW(-2));
    const far = Math.abs(clipW(-200));
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near); // ægte perspektiv: w vokser med dybden

    const params = { baseSizePx: 64, maxSizePx: 32, densityFactor: 1.0, viewportPx: 1000 };
    const nearSize = computePointSize(near, params);
    const farSize = computePointSize(far, params);

    // Ward 23's formel er ikke længere en no-op: nær > fjern
    expect(nearSize).toBeGreaterThan(farSize);
    expect(farSize).toBeGreaterThanOrEqual(1.0);
    expect(nearSize).toBeLessThanOrEqual(32);
  });

  // ─── T9 ────────────────────────────────────────────────────────

  it("T9: file_is_never_held_whole_in_a_js_array_buffer", async () => {
    const bytes = new Uint8Array(64 * 1024 + 123).fill(7);
    bytes.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF"

    const arrayBuffer = vi.fn(async () => bytes.buffer);
    let position = 0;
    const file = {
      name: "scan.laz",
      size: bytes.byteLength,
      arrayBuffer,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => bytes.slice(start, end).buffer,
      }),
      stream: () => new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position >= bytes.byteLength) { controller.close(); return; }
          const end = Math.min(position + 16 * 1024, bytes.byteLength);
          controller.enqueue(bytes.subarray(position, end));
          position = end;
        },
      }),
    } as unknown as File;

    const written: number[] = [];
    const sink = { write: async (chunk: Uint8Array) => { written.push(chunk.byteLength); } };

    await loadSceneFile(file, sink);

    // Hele pointen: filen læses som en strøm, aldrig som én buffer
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(written.length).toBeGreaterThan(1);
    expect(written.reduce((a, b) => a + b, 0)).toBe(bytes.byteLength);
  });

  // ─── T10 ───────────────────────────────────────────────────────

  it("T10: render_mode_defaults_to_points_and_splat_path_stays_reachable", () => {
    // Appen er en LiDAR-viewer nu; splats er baseline bag flaget
    expect(DEFAULT_RENDER_MODE).toBe("points");
    expect(pipelineForRenderMode("points")).toBe("colored-point");
    expect(pipelineForRenderMode("splats")).toBe("splat");
  });
});
