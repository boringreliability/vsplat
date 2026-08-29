/**
 * vsplat — LiDAR point cloud studio.
 *
 * Ward 026: appen kører nu LiDAR-stien. Epic 06 byggede hele motoren —
 * LAS/LAZ-parser (Ward 21/25), point-pipeline (Ward 20), color ramps (Ward 22),
 * batched draws (Ward 23) — men den lå i `las-smoke.html`, mens denne fil
 * stadig pegede på den deferrede 3DGS-sti. Her flyttes den ind, med den
 * I/O-model projektet altid har krævet: filen streames fra drop til OPFS til
 * Wasm-parser uden nogensinde at ligge samlet i JS-heapen.
 *
 * Splat-stien er ikke slettet — den er nået via `RENDER_MODE = "splats"` og
 * forbliver regression-baseline for Ward 5-7, 12 og 19.
 */

import { checkCapabilities } from "../errors/capability-gate.js";
import { checkSceneMemory } from "../errors/memory-pressure.js";
import { type VsplatError } from "../errors/vsplat-error.js";
import { OrbitController } from "../camera/orbit.js";
import { lookAtMatrix, multiplyMatrices, perspectiveMatrix } from "../camera/math.js";
import { initOpfsStorage } from "../opfs/storage.js";
import { loadSceneFile, type ChunkSink } from "./scene-loader.js";
import { DEFAULT_RENDER_MODE, pipelineForRenderMode } from "./render-mode.js";
import { normalizeScene } from "../render/normalize.js";
import { BatchManager, permuteAttribute, type Batch } from "../render/batch-manager.js";
import { flattenPlanes } from "../render/frustum-cull.js";
import { drawArgsFor, planBatchDraws } from "../render/draw-plan.js";
import { extractFrustumPlanes } from "../selection/frustum.js";
import { AdaptiveDensityThrottler } from "../render/adaptive-density.js";
import { compileColoredPointPipeline, type ColoredPointPipeline } from "../webgpu/colored-point-pipeline.js";
import {
  ColorModeUniform, MODE_INTENSITY, VIRIDIS_RAMP, repackRgbToRgba, uploadColorRamp,
} from "../webgpu/color-ramps.js";

// ─── Konfiguration ───────────────────────────────────────────────

const RENDER_MODE = DEFAULT_RENDER_MODE;
const BASE_POINT_SIZE_PX = 2.0;
const MAX_POINT_SIZE_PX = 32.0;
/** Chunk-størrelse ud til workeren. Én chunk ad gangen i JS — aldrig hele filen. */
const STREAM_CHUNK_BYTES = 1 * 1024 * 1024;

// ─── UI ──────────────────────────────────────────────────────────

function showError(err: VsplatError | Error | string): void {
  const el = document.getElementById("error");
  const message = typeof err === "string" ? err : err.message;
  if (el) { el.textContent = message; el.style.display = "block"; }
  console.error("[vsplat]", err);
}

function setStatus(text: string): void {
  const el = document.getElementById("drop-hint");
  if (el) el.textContent = text;
}

// ─── Worker-protokol ─────────────────────────────────────────────

interface LasLoaded {
  pointCount: number;
  hasRgb: boolean;
  hasClassification: boolean;
  compressed: boolean;
}

interface LasBuffers {
  positions: Float32Array;
  intensity: Uint16Array;
  rgb: Uint8Array;
  classification: Uint8Array;
}

/** Tynd wrapper om workeren: promises for de to svar vi venter på. */
class LasWorkerClient {
  private loaded: ((r: LasLoaded) => void) | null = null;
  private buffers: ((b: LasBuffers) => void) | null = null;
  private failed: ((e: Error) => void) | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly onProgress: (bytes: number, total: number) => void,
  ) {
    worker.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data as { type: string } & Record<string, unknown>;
      switch (msg.type) {
        case "las-progress":
          this.onProgress(msg.bytesProcessed as number, msg.totalBytes as number);
          break;
        case "las-loaded":
          this.loaded?.(msg as unknown as LasLoaded);
          this.loaded = null;
          break;
        case "las-buffers":
          this.buffers?.(msg as unknown as LasBuffers);
          this.buffers = null;
          break;
        case "las-error":
          this.failed?.(new Error(String(msg.message)));
          this.loaded = null;
          this.buffers = null;
          break;
      }
    });
  }

  begin(totalBytes: number): void {
    this.worker.postMessage({ type: "las-begin", totalBytes, chunkSize: STREAM_CHUNK_BYTES });
  }

  /** Sender én chunk videre. Kopien er bevidst: originalen skal også i OPFS. */
  pushChunk(chunk: Uint8Array): void {
    const copy = chunk.slice();
    this.worker.postMessage({ type: "las-chunk", chunk: copy.buffer }, [copy.buffer]);
  }

  end(): Promise<LasLoaded> {
    return new Promise((resolve, reject) => {
      this.loaded = resolve;
      this.failed = reject;
      this.worker.postMessage({ type: "las-end" });
    });
  }

  getBuffers(): Promise<LasBuffers> {
    return new Promise((resolve, reject) => {
      this.buffers = resolve;
      this.failed = reject;
      this.worker.postMessage({ type: "las-get-buffers" });
    });
  }
}

// ─── Scene-state ─────────────────────────────────────────────────

interface Scene {
  pointCount: number;
  batches: Batch[];
  positionsBuffer: GPUBuffer;
  intensityBuffer: GPUBuffer;
  rgbBuffer: GPUBuffer;
  classificationBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

function packU16ToU32(src: Uint16Array): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i]!;
  return out;
}

function packU8ToU32(src: Uint8Array): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i]!;
  return out;
}

// ─── Main ────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const caps = checkCapabilities();
  if (caps.error) { showError(caps.error); return; }
  caps.warnings.forEach(w => console.warn(`[vsplat] ${w.code}: ${w.message}`));

  if (pipelineForRenderMode(RENDER_MODE) === "splat") {
    showError('RENDER_MODE="splats" er regression-baseline og startes fra points-smoke/las-smoke.');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { showError("Ingen GPU adapter."); return; }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });

  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // Ward 26: view-projection som uniform — uden den er clip_w altid 1.0,
  // og Ward 23's perspektiv-korrekte point size er en no-op.
  const pipeline: ColoredPointPipeline = await compileColoredPointPipeline(
    device, format, { viewProj: "uniform" },
  );

  let depthTexture = device.createTexture({
    label: "depth",
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const rampTexture = uploadColorRamp(device, VIRIDIS_RAMP);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const colorUniform = device.createBuffer({
    label: "color-mode-uniform", size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sizeUniform = device.createBuffer({
    label: "point-size-uniform", size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const viewProjUniform = device.createBuffer({
    label: "view-proj-uniform", size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ─── Kamera ───────────────────────────────────────────────────

  const orbit = new OrbitController({
    target: [0, 0, 0], distance: 3.0, azimuth: 0.6, elevation: 0.5,
  });
  const throttler = new AdaptiveDensityThrottler();

  let dragging = false;
  let lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", e => {
    dragging = false; canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    if (!dragging) return;
    orbit.rotate((e.clientX - lastX) * 0.005, (e.clientY - lastY) * 0.005);
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    orbit.zoom(e.deltaY * 0.001);
  }, { passive: false });

  function viewProjection(): Float32Array {
    const proj = perspectiveMatrix(
      Math.PI / 4, canvas.width / canvas.height, 0.01, 100,
    );
    const view = lookAtMatrix(orbit.getPosition(), orbit.getTarget(), [0, 1, 0]);
    return multiplyMatrices(proj, view);
  }

  // ─── Worker ───────────────────────────────────────────────────

  const worker = new Worker(new URL("../worker/wasm-worker.ts", import.meta.url), { type: "module" });
  const wasmUrl = new URL("/vsplat_core.js", window.location.origin).href;
  await new Promise<void>((resolve, reject) => {
    const onReady = (e: MessageEvent): void => {
      if (e.data?.type === "ready") { worker.removeEventListener("message", onReady); resolve(); }
      if (e.data?.type === "error") reject(new Error(String(e.data.message)));
    };
    worker.addEventListener("message", onReady);
    worker.postMessage({ type: "init", wasmUrl });
  });

  const client = new LasWorkerClient(worker, (bytes, total) => {
    setStatus(`Indlæser… ${((bytes / Math.max(total, 1)) * 100).toFixed(0)} %`);
  });

  const opfs = await initOpfsStorage();
  let scene: Scene | null = null;

  // ─── Load ─────────────────────────────────────────────────────

  async function loadFile(file: File): Promise<void> {
    setStatus(`Læser ${file.name}…`);
    client.begin(file.size);

    // Én chunk ad gangen: den skrives til OPFS og sendes til workeren i samme
    // gennemløb. Filen samles aldrig i en ArrayBuffer på JS-siden.
    const handle = await opfs.root.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    const sink: ChunkSink = {
      async write(chunk) {
        // Casten dækker et lib-typing-hul: TS's FileSystemWritableStream vil have
        // en view over ArrayBuffer, mens ReadableStream giver ArrayBufferLike.
        // Ingen kopi her — OPFS skriver originalen, workeren får kopien.
        await writable.write(chunk as unknown as ArrayBufferView<ArrayBuffer>);
        client.pushChunk(chunk);
      },
    };

    let format: string;
    try {
      ({ format } = await loadSceneFile(file, sink));
    } finally {
      await writable.close();
    }

    if (format !== "las") {
      showError(`${file.name} er en PLY-fil. Splat-stien kører under RENDER_MODE="splats".`);
      return;
    }

    const loaded = await client.end();

    // Ward 26: memory-gaten kender nu forskel på et splat og et LiDAR-punkt.
    // Med splat-tallet ville 20M punkter være blevet afvist her.
    const gate = checkSceneMemory(loaded.pointCount, 0, undefined, "points", loaded.compressed);
    if (gate) { showError(gate); return; }

    const buffers = await client.getBuffers();
    setStatus("");
    uploadScene(loaded, buffers);
  }

  function uploadScene(loaded: LasLoaded, raw: LasBuffers): void {
    const { positions } = normalizeScene(raw.positions);
    // Ward 23: k-d subdivision pakker punkterne om, så hver batch er en
    // sammenhængende slice. Attributterne SKAL følge permutationen.
    const subdivision = BatchManager.subdivide(positions);
    const perm = subdivision.permutation;
    const intensity = permuteAttribute(raw.intensity, perm, 1);
    const classification = permuteAttribute(raw.classification, perm, 1);
    const rgba = raw.rgb.length === loaded.pointCount * 3
      ? repackRgbToRgba(permuteAttribute(raw.rgb, perm, 3))
      : new Uint8Array(loaded.pointCount * 4).fill(128);

    scene?.positionsBuffer.destroy();
    scene?.intensityBuffer.destroy();
    scene?.rgbBuffer.destroy();
    scene?.classificationBuffer.destroy();

    const storage = (label: string, data: BufferSource): GPUBuffer => {
      const buf = device.createBuffer({
        label, size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data);
      return buf;
    };

    const positionsBuffer = storage("splat-positions", subdivision.positions);
    const intensityBuffer = storage("las-intensity", packU16ToU32(intensity));
    const rgbBuffer = storage("las-rgb", rgba);
    const classificationBuffer = storage("las-classification", packU8ToU32(classification));

    device.queue.writeBuffer(
      colorUniform, 0, new ColorModeUniform(0, 65535, MODE_INTENSITY).toArrayBuffer(),
    );

    scene = {
      pointCount: loaded.pointCount,
      batches: subdivision.batches,
      positionsBuffer, intensityBuffer, rgbBuffer, classificationBuffer,
      bindGroup: device.createBindGroup({
        label: "colored-point-bg",
        layout: pipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: positionsBuffer } },
          { binding: 1, resource: { buffer: intensityBuffer } },
          { binding: 2, resource: { buffer: rgbBuffer } },
          { binding: 3, resource: { buffer: classificationBuffer } },
          { binding: 4, resource: rampTexture.createView({ dimension: "1d" }) },
          { binding: 5, resource: sampler },
          { binding: 6, resource: { buffer: colorUniform } },
          { binding: 7, resource: { buffer: sizeUniform } },
          { binding: 8, resource: { buffer: viewProjUniform } },
        ],
      }),
    };

    console.log(
      `[vsplat] ${loaded.pointCount.toLocaleString("da-DK")} punkter` +
      `${loaded.compressed ? " (LAZ)" : ""} i ${subdivision.batches.length} batches`,
    );
  }

  // ─── Drop ─────────────────────────────────────────────────────

  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) loadFile(file).catch(err => showError(err as Error));
  });

  // ─── Render loop ──────────────────────────────────────────────

  function frame(): void {
    if (canvas.width !== canvas.clientWidth * devicePixelRatio
      || canvas.height !== canvas.clientHeight * devicePixelRatio) {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
      depthTexture.destroy();
      depthTexture = device.createTexture({
        label: "depth", size: [canvas.width, canvas.height],
        format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    throttler.recordFrame();
    const vp = viewProjection();
    device.queue.writeBuffer(viewProjUniform, 0, vp);
    device.queue.writeBuffer(sizeUniform, 0, new Float32Array([
      BASE_POINT_SIZE_PX, MAX_POINT_SIZE_PX, throttler.factor(), canvas.height,
    ]));

    const encoder = device.createCommandEncoder({ label: "frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.08, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
      },
    });

    if (scene) {
      pass.setPipeline(pipeline.pipeline);
      // Én delt bind group; kun draw-range varierer per batch (Ward 23).
      pass.setBindGroup(0, scene.bindGroup);
      const plan = planBatchDraws(scene.batches, flattenPlanes(extractFrustumPlanes(vp)));
      for (const range of plan.ranges) {
        const { vertexCount, firstVertex } = drawArgsFor(range);
        pass.draw(vertexCount, 1, firstVertex, 0);
      }
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  setStatus("Drop en .las eller .laz fil her");
}

main().catch(err => showError(err as Error));
