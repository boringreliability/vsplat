/**
 * Ward 21 — LAS Ingestion Smoke Test.
 *
 * End-to-end pipeline test:
 *   ArrayBuffer (LAS) → Wasm las_parse_chunk → positions buffer → GPU → Ward 20 point pipeline
 *
 * Bypass Worker for enkelhed — kører Wasm direkte i main thread. Det er ikke
 * produktion (Ward 21 leverer LasBridge til Worker), men det beviser at hele
 * stacken fra Rust-parser til GPU-render fungerer end-to-end.
 *
 * Drop en .las-fil eller klik "Generér syntetisk" for en PDRF 3 helix.
 */

import {
  compilePointPipeline,
  encodePointRenderPass,
  RENDER_MODE_POINTS,
} from "../webgpu/point-pipeline.js";

const POINT_COUNT_SYNTH = 50_000;

interface WasmModule {
  default: (input?: unknown) => Promise<{ memory: WebAssembly.Memory }>;
  las_init(): void;
  las_parse_chunk(data: Uint8Array): number;
  las_positions_ptr(): number;
  las_positions_len(): number;
  las_intensity_ptr(): number;
  las_intensity_len(): number;
  las_rgb_ptr(): number;
  las_rgb_len(): number;
  las_classification_ptr(): number;
  las_classification_len(): number;
  las_point_count(): number;
}

function showError(msg: string): void {
  const el = document.getElementById("error")!;
  el.textContent = msg;
  el.style.display = "block";
  console.error("[las-smoke]", msg);
}

// ─── Synthetic LAS Generator ─────────────────────────────────────

/** Build a PDRF 3 LAS file with a 3D helix of `count` points. */
function generateSyntheticLas(count: number): ArrayBuffer {
  const HEADER_SIZE = 375;
  const RECORD_LEN = 34;
  const total = HEADER_SIZE + count * RECORD_LEN;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Magic
  u8[0] = 0x4c; u8[1] = 0x41; u8[2] = 0x53; u8[3] = 0x46;
  // Version 1.4
  u8[24] = 1; u8[25] = 4;
  // Header size
  view.setUint16(94, HEADER_SIZE, true);
  // Point data offset
  view.setUint32(96, HEADER_SIZE, true);
  // Num VLRs
  view.setUint32(100, 0, true);
  // PDRF 3
  u8[104] = 3;
  // Record length
  view.setUint16(105, RECORD_LEN, true);
  // Legacy num points (u32)
  view.setUint32(107, count, true);
  // Scale (mm precision)
  view.setFloat64(131, 0.001, true);
  view.setFloat64(139, 0.001, true);
  view.setFloat64(147, 0.001, true);
  // Offset (zero — helix is centered)
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  // v1.4 64-bit count
  view.setBigUint64(247, BigInt(count), true);

  // Point records: 3D helix with rainbow RGB
  // World coordinates ~[-0.7, 0.7]³ → i32 input ~[-700, 700] with scale 0.001
  let off = HEADER_SIZE;
  const turns = 5;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const angle = t * Math.PI * 2 * turns;
    const radius = 0.55 * (1 - t * 0.4); // tapering
    const x = radius * Math.cos(angle);
    const y = (t - 0.5) * 1.4;
    const z = radius * Math.sin(angle);
    // Quantize to i32 with scale 0.001
    view.setInt32(off + 0, Math.round(x * 1000), true);
    view.setInt32(off + 4, Math.round(y * 1000), true);
    view.setInt32(off + 8, Math.round(z * 1000), true);
    // Intensity: rainbow
    view.setUint16(off + 12, Math.floor(t * 65535), true);
    // Return flags = 0 (off+14)
    // Classification = (i % 3) + 2 (off+15) — varied for visual
    u8[off + 15] = (i % 3) + 2;
    // Scan angle, user data, point source ID = 0 (off+16..19)
    // GPS time = 0 (off+20..27)
    view.setFloat64(off + 20, 0, true);
    // RGB (u16) — HSV-style rainbow scaled to 16-bit
    const hue = t * 6;
    const c = 1.0;
    const xrgb = c * (1 - Math.abs((hue % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hue < 1) { r = c; g = xrgb; }
    else if (hue < 2) { r = xrgb; g = c; }
    else if (hue < 3) { g = c; b = xrgb; }
    else if (hue < 4) { g = xrgb; b = c; }
    else if (hue < 5) { r = xrgb; b = c; }
    else { r = c; b = xrgb; }
    view.setUint16(off + 28, Math.floor(r * 65535), true);
    view.setUint16(off + 30, Math.floor(g * 65535), true);
    view.setUint16(off + 32, Math.floor(b * 65535), true);
    off += RECORD_LEN;
  }
  return buf;
}

// ─── Wasm + Parse Pipeline ───────────────────────────────────────

let wasmMod: WasmModule | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (wasmMod) return wasmMod;
  // Vite forbyder string-literal import af filer i publicDir (pkg/).
  // En variable URL omgår dette ved at gøre importen dynamisk for Vite's analyzer.
  const wasmUrl = new URL("/vsplat_core.js", window.location.origin).href;
  const mod = (await import(/* @vite-ignore */ wasmUrl)) as unknown as WasmModule;
  const exports = await mod.default();
  wasmMemory = exports.memory;
  wasmMod = mod;
  return mod;
}

interface ParsedLas {
  pointCount: number;
  positions: Float32Array;
  parseMs: number;
}

async function parseLas(data: ArrayBuffer): Promise<ParsedLas> {
  const mod = await loadWasm();
  mod.las_init();
  const u8 = new Uint8Array(data);
  const CHUNK = 64 * 1024;
  const t0 = performance.now();
  let offset = 0;
  while (offset < u8.length) {
    const end = Math.min(offset + CHUNK, u8.length);
    mod.las_parse_chunk(u8.subarray(offset, end));
    offset = end;
  }
  const parseMs = performance.now() - t0;

  const ptr = mod.las_positions_ptr();
  const len = mod.las_positions_len();
  // Zero-copy view into Wasm memory
  const positions = new Float32Array(wasmMemory!.buffer, ptr, len);
  return { pointCount: mod.las_point_count(), positions, parseMs };
}

/** Normalize positions to [-0.85, 0.85]³ around their centroid so they fit Ward 20's clip space. */
function normalizePositions(positions: Float32Array): Float32Array {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
  const scale = 1.7 / Math.max(ex, ey, ez, 1e-6);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i + 0] = (positions[i + 0]! - cx) * scale;
    out[i + 1] = (positions[i + 1]! - cy) * scale;
    out[i + 2] = (positions[i + 2]! - cz) * scale;
  }
  return out;
}

// ─── Render Loop State ───────────────────────────────────────────

let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let pipeline: Awaited<ReturnType<typeof compilePointPipeline>> | null = null;
let depthTexture: GPUTexture | null = null;
let positionsBuffer: GPUBuffer | null = null;
let bindGroup: GPUBindGroup | null = null;
let currentPointCount = 0;
let rotationPaused = false;
let rotationAngle = 0;
let normalizedSource: Float32Array | null = null;
let scratch: Float32Array | null = null;

function rotateY(out: Float32Array, src: Float32Array, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!, z = src[i + 2]!;
    out[i + 0] = c * x + s * z;
    out[i + 1] = src[i + 1]!;
    out[i + 2] = -s * x + c * z;
  }
}

async function uploadScene(positions: Float32Array): Promise<void> {
  if (!device || !pipeline) throw new Error("device not ready");
  normalizedSource = normalizePositions(positions);
  scratch = new Float32Array(normalizedSource.length);
  scratch.set(normalizedSource);

  if (positionsBuffer) positionsBuffer.destroy();
  positionsBuffer = device.createBuffer({
    label: "smoke-las-positions",
    size: scratch.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionsBuffer, 0, scratch);

  bindGroup = device.createBindGroup({
    label: "smoke-las-bg",
    layout: pipeline.bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: positionsBuffer } }],
  });
  currentPointCount = positions.length / 3;
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!navigator.gpu) { showError("WebGPU er ikke tilgængelig."); return; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { showError("Ingen GPU adapter."); return; }
  device = await adapter.requestDevice();

  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  pipeline = await compilePointPipeline(device, format);
  depthTexture = device.createTexture({
    label: "smoke-las-depth",
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const fileNameEl = document.getElementById("file-name")!;
  const pointCountEl = document.getElementById("point-count")!;
  const parseTimeEl = document.getElementById("parse-time")!;
  const fpsEl = document.getElementById("fps")!;

  // Drag-and-drop
  canvas.addEventListener("dragover", e => e.preventDefault());
  canvas.addEventListener("drop", async e => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    fileNameEl.textContent = `${file.name} (${(file.size / 1e6).toFixed(1)} MB)`;
    try {
      const data = await file.arrayBuffer();
      // Diagnostic: log first 32 bytes so we can see what the file actually starts with
      const head = new Uint8Array(data, 0, Math.min(32, data.byteLength));
      const hex = Array.from(head).map(b => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = Array.from(head).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
      console.log(`[las-smoke] first 32 bytes hex: ${hex}`);
      console.log(`[las-smoke] first 32 bytes ascii: ${ascii}`);
      // Verify magic
      if (head[0] !== 0x4c || head[1] !== 0x41 || head[2] !== 0x53 || head[3] !== 0x46) {
        const got = String.fromCharCode(head[0] ?? 0, head[1] ?? 0, head[2] ?? 0, head[3] ?? 0);
        showError(`Filen starter ikke med "LASF" magic — fik "${got}" (hex: ${hex.slice(0, 11)}). Er det en gyldig LAS-fil?`);
        return;
      }
      // LAZ detection: PDRF byte at offset 104 has high bit set when compressed.
      // (Headeren har magic "LASF" selvom indholdet er komprimeret.)
      if (data.byteLength > 104) {
        const pdrf = new Uint8Array(data, 104, 1)[0]!;
        if (pdrf & 0x80) {
          showError(
            `Dette er en LAZ-komprimeret fil (PDRF 0x${pdrf.toString(16)}). ` +
            `Ward 21 leverer kun ukomprimeret LAS — LAZ-decode er skubbet til Ward 25. ` +
            `Konverter filen til .las med fx "las2las" eller "laszip -decompress".`,
          );
          return;
        }
      }
      const r = await parseLas(data);
      pointCountEl.textContent = r.pointCount.toLocaleString("da-DK");
      parseTimeEl.textContent = `${r.parseMs.toFixed(0)}ms (${(r.pointCount / r.parseMs).toFixed(0)} points/ms)`;
      await uploadScene(r.positions);
      console.log(`[las-smoke] loaded ${r.pointCount} points in ${r.parseMs.toFixed(0)}ms`);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  // Synthetic generator
  document.getElementById("generate-btn")!.addEventListener("click", async () => {
    fileNameEl.textContent = `synthetic helix (${POINT_COUNT_SYNTH} points, PDRF 3)`;
    try {
      const data = generateSyntheticLas(POINT_COUNT_SYNTH);
      const r = await parseLas(data);
      pointCountEl.textContent = r.pointCount.toLocaleString("da-DK");
      parseTimeEl.textContent = `${r.parseMs.toFixed(0)}ms (${(r.pointCount / r.parseMs).toFixed(0)} points/ms)`;
      await uploadScene(r.positions);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") rotationPaused = !rotationPaused;
  });

  // Render loop
  let lastFrame = performance.now();
  let fpsAccum = 0, fpsFrames = 0;
  const radixStub = { dispatch: () => {} };

  function frame(): void {
    const now = performance.now();
    const dt = now - lastFrame; lastFrame = now;
    fpsAccum += dt; fpsFrames++;
    if (fpsFrames >= 30) {
      fpsEl.textContent = `${(1000 / (fpsAccum / fpsFrames)).toFixed(0)}`;
      fpsAccum = 0; fpsFrames = 0;
    }

    if (bindGroup && positionsBuffer && normalizedSource && scratch && currentPointCount > 0) {
      if (!rotationPaused) {
        rotationAngle += dt * 0.0005;
        rotateY(scratch, normalizedSource, rotationAngle);
        device!.queue.writeBuffer(positionsBuffer, 0, scratch);
      }
      const encoder = device!.createCommandEncoder({ label: "las-smoke-encoder" });
      encodePointRenderPass(encoder, pipeline!, {
        mode: RENDER_MODE_POINTS,
        pointCount: currentPointCount,
        colorView: context!.getCurrentTexture().createView(),
        depthView: depthTexture!.createView(),
        bindGroup,
        radixSort: radixStub,
      });
      device!.queue.submit([encoder.finish()]);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  console.log("[las-smoke] Ward 21 smoke ready — drop .las or click generate");
}

main().catch(err => showError(err instanceof Error ? err.message : String(err)));
