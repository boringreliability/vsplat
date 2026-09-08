/**
 * Ward 21 + 22 — LAS Ingestion + Color Ramp Smoke Test.
 *
 * End-to-end:
 *   ArrayBuffer → Wasm las_parse_chunk → SoA buffers (positions, intensity, rgb,
 *   classification) → GPU → either Ward 20 (white) or Ward 22 (colored ramp) pipeline.
 */

import {
  compilePointPipeline,
  encodePointRenderPass,
  RENDER_MODE_POINTS,
} from "../webgpu/point-pipeline.js";
import {
  compileColoredPointPipeline,
  type ColoredPointPipeline,
} from "../webgpu/colored-point-pipeline.js";
import {
  VIRIDIS_RAMP,
  INFERNO_RAMP,
  GRAYSCALE_RAMP,
  ELEVATION_RAMP,
  CLASS_PALETTE,
  ColorModeUniform,
  MODE_INTENSITY,
  MODE_CLASSIFICATION,
  MODE_RGB_DIRECT,
  MODE_ELEVATION,
  type ColorMode,
  repackRgbToRgba,
  uploadColorRamp,
} from "../webgpu/color-ramps.js";
import { AdaptiveDensityThrottler } from "../render/adaptive-density.js";
import { BatchManager, permuteAttribute, type Batch } from "../render/batch-manager.js";
import { flattenPlanes } from "../render/frustum-cull.js";
import { drawArgsFor, planBatchDraws } from "../render/draw-plan.js";
import { extractFrustumPlanes } from "../selection/frustum.js";
import { VIEW_PROJ_MATRIX } from "../webgpu/colored-point-pipeline.js";

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
  las_compressed(): boolean;
}

function showError(msg: string): void {
  const el = document.getElementById("error")!;
  el.textContent = msg;
  el.style.display = "block";
  console.error("[las-smoke]", msg);
}

// ─── Synthetic LAS Generator (unchanged from Ward 21) ──────────

function generateSyntheticLas(count: number): ArrayBuffer {
  const HEADER_SIZE = 375;
  const RECORD_LEN = 34;
  const total = HEADER_SIZE + count * RECORD_LEN;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x4c; u8[1] = 0x41; u8[2] = 0x53; u8[3] = 0x46;
  u8[24] = 1; u8[25] = 4;
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, HEADER_SIZE, true);
  view.setUint32(100, 0, true);
  u8[104] = 3;
  view.setUint16(105, RECORD_LEN, true);
  view.setUint32(107, count, true);
  view.setFloat64(131, 0.001, true);
  view.setFloat64(139, 0.001, true);
  view.setFloat64(147, 0.001, true);
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  view.setBigUint64(247, BigInt(count), true);
  let off = HEADER_SIZE;
  const turns = 5;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const angle = t * Math.PI * 2 * turns;
    const radius = 0.55 * (1 - t * 0.4);
    const x = radius * Math.cos(angle);
    const y = (t - 0.5) * 1.4;
    const z = radius * Math.sin(angle);
    view.setInt32(off + 0, Math.round(x * 1000), true);
    view.setInt32(off + 4, Math.round(y * 1000), true);
    view.setInt32(off + 8, Math.round(z * 1000), true);
    view.setUint16(off + 12, Math.floor(t * 65535), true);
    // Classification: vary 2-5 over the helix for visible variety
    u8[off + 15] = (i % 4) + 2;
    view.setFloat64(off + 20, 0, true);
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

// ─── Wasm + Parse ─────────────────────────────────────────────────

let wasmMod: WasmModule | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (wasmMod) return wasmMod;
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
  intensity: Uint16Array;
  rgb: Uint8Array;
  classification: Uint8Array;
  parseMs: number;
  /** True hvis filen var LAZ-komprimeret (dekomprimeret i Rust, Ward 25). */
  compressed: boolean;
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

  const mem = wasmMemory!.buffer;
  // IMPORTANT: copy out of wasm memory because subsequent las_init() / parse_chunk()
  // may grow the memory and invalidate ArrayBuffer views.
  const positions = new Float32Array(new Float32Array(mem, mod.las_positions_ptr(), mod.las_positions_len()));
  const intensity = new Uint16Array(new Uint16Array(mem, mod.las_intensity_ptr(), mod.las_intensity_len()));
  const rgb = new Uint8Array(new Uint8Array(mem, mod.las_rgb_ptr(), mod.las_rgb_len()));
  const classification = new Uint8Array(new Uint8Array(mem, mod.las_classification_ptr(), mod.las_classification_len()));

  return {
    pointCount: mod.las_point_count(), positions, intensity, rgb, classification, parseMs,
    compressed: mod.las_compressed(),
  };
}

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

/** Pack u16 array to u32 array (2 u16 per u32, little-endian). */
function packU16ToU32(src: Uint16Array): Uint32Array {
  const wordCount = Math.ceil(src.length / 2);
  const out = new Uint32Array(wordCount);
  for (let i = 0; i < src.length; i++) {
    const word = i >> 1;
    const shift = (i & 1) * 16;
    out[word] |= (src[i]! & 0xFFFF) << shift;
  }
  return out;
}

/** Pack u8 array to u32 array (4 u8 per u32, little-endian). */
function packU8ToU32(src: Uint8Array): Uint32Array {
  const wordCount = Math.ceil(src.length / 4);
  const out = new Uint32Array(wordCount);
  for (let i = 0; i < src.length; i++) {
    const word = i >> 2;
    const shift = (i & 3) * 8;
    out[word] |= (src[i]! & 0xFF) << shift;
  }
  return out;
}

function minMaxU16(arr: Uint16Array): [number, number] {
  let mn = 0xFFFF, mx = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]!;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

function minMaxY(positions: Float32Array): [number, number] {
  let mn = Infinity, mx = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const v = positions[i]!;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

// ─── Render Loop State ───────────────────────────────────────────

let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let pointPipeline: Awaited<ReturnType<typeof compilePointPipeline>> | null = null;
let coloredPipeline: ColoredPointPipeline | null = null;
let depthTexture: GPUTexture | null = null;

// Buffers (re-allocated per scene)
let positionsBuffer: GPUBuffer | null = null;
let intensityBuffer: GPUBuffer | null = null;
let rgbBuffer: GPUBuffer | null = null;
let classificationBuffer: GPUBuffer | null = null;
let uniformBuffer: GPUBuffer | null = null;
let sizeUniformBuffer: GPUBuffer | null = null;  // Ward 23

let baseSizePx = 2.0;
let viewportPx = 1000;
const throttler = new AdaptiveDensityThrottler();
/** Ward 23: k-d batches over de ompakkede positions. Tom = ingen scene endnu. */
let sceneBatches: Batch[] = [];

// Textures + sampler (created once, ramp swapped on mode change)
let rampTexture: GPUTexture | null = null;
let sampler: GPUSampler | null = null;

// Bind groups
let whiteBindGroup: GPUBindGroup | null = null;
let coloredBindGroup: GPUBindGroup | null = null;

let currentPointCount = 0;
let rotationPaused = false;
let rotationAngle = 0;
let normalizedSource: Float32Array | null = null;
let scratch: Float32Array | null = null;

type UiMode = "white" | "viridis" | "inferno" | "grayscale" | "elevation" | "classification" | "rgb";
let currentUiMode: UiMode = "viridis";
let intensityRange: [number, number] = [0, 65535];
let elevationRange: [number, number] = [-1, 1];

/** Column-major rotation om Y — samme rotation som `rotateY` anvender på punkterne. */
function rotationMatrixY(angle: number): Float32Array {
  const c = Math.cos(angle), s = Math.sin(angle);
  // rotateY() beregner x' = c*x + s*z, z' = -s*x + c*z
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

/** Column-major 4x4 multiplikation: returnerer a · b. */
function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function rotateY(out: Float32Array, src: Float32Array, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!, z = src[i + 2]!;
    out[i + 0] = c * x + s * z;
    out[i + 1] = src[i + 1]!;
    out[i + 2] = -s * x + c * z;
  }
}

function rampDataFor(mode: UiMode): Uint8Array {
  switch (mode) {
    case "viridis": return VIRIDIS_RAMP;
    case "inferno": return INFERNO_RAMP;
    case "grayscale": return GRAYSCALE_RAMP;
    case "elevation": return ELEVATION_RAMP;
    case "classification": {
      // CLASS_PALETTE is 32×4 = 128 bytes. Pad to 1024 (256×4) by repeating
      // so we can reuse the same 1D 256-entry texture infrastructure.
      const out = new Uint8Array(1024);
      for (let i = 0; i < 256; i++) {
        const src = (i % 32) * 4;
        out[i * 4 + 0] = CLASS_PALETTE[src + 0]!;
        out[i * 4 + 1] = CLASS_PALETTE[src + 1]!;
        out[i * 4 + 2] = CLASS_PALETTE[src + 2]!;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    default: return VIRIDIS_RAMP;
  }
}

function colorModeFor(mode: UiMode): ColorMode {
  switch (mode) {
    case "classification": return MODE_CLASSIFICATION;
    case "rgb": return MODE_RGB_DIRECT;
    case "elevation": return MODE_ELEVATION;
    default: return MODE_INTENSITY; // viridis/inferno/grayscale all use intensity normalization
  }
}

function updateRampAndUniform(mode: UiMode): void {
  if (!device || !rampTexture || !uniformBuffer) return;
  const ramp = rampDataFor(mode);
  device.queue.writeTexture(
    { texture: rampTexture },
    ramp,
    { bytesPerRow: 256 * 4 },
    [256, 1, 1],
  );
  const cMode = colorModeFor(mode);
  let min = intensityRange[0], max = intensityRange[1];
  if (mode === "elevation") { min = elevationRange[0]; max = elevationRange[1]; }
  const uni = new ColorModeUniform(min, max, cMode);
  device.queue.writeBuffer(uniformBuffer, 0, uni.toArrayBuffer());
}

/** Ward 23: write size uniform (4 scalars, 16 bytes). */
function writeSizeUniform(): void {
  if (!device || !sizeUniformBuffer) return;
  const buf = new Float32Array(4);
  buf[0] = baseSizePx;
  buf[1] = 32.0;
  buf[2] = throttler.factor();
  buf[3] = viewportPx;
  device.queue.writeBuffer(sizeUniformBuffer, 0, buf);
}

async function uploadScene(parsed: ParsedLas): Promise<void> {
  if (!device || !pointPipeline || !coloredPipeline) throw new Error("device not ready");

  // Normalize positions to clip space, dernæst Ward 23's k-d subdivision.
  // Rækkefølgen er vigtig: batchenes AABB'er skal ligge i samme rum som det
  // shaderen læser, altså normaliseret og uroteret (rotationen håndteres som
  // model-matrix i frustum-planerne, ikke ved at flytte AABB'erne).
  const normalized = normalizePositions(parsed.positions);
  const subdivision = BatchManager.subdivide(normalized);
  sceneBatches = subdivision.batches;
  normalizedSource = subdivision.positions;
  scratch = new Float32Array(normalizedSource.length);
  scratch.set(normalizedSource);
  elevationRange = minMaxY(normalizedSource);

  // Attributterne SKAL følge permutationen — ellers får punkterne hinandens farver.
  const perm = subdivision.permutation;
  const intensity = permuteAttribute(parsed.intensity, perm, 1);
  const classification = permuteAttribute(parsed.classification, perm, 1);
  intensityRange = minMaxU16(intensity);

  // Pack u16 intensity → u32 storage
  const intensityPacked = packU16ToU32(intensity);
  // Pack u8 classification → u32 storage
  const classPacked = packU8ToU32(classification);
  // Re-pack 3-byte rgb → 4-byte RGBA (only if buffer has data)
  const pointCount = parsed.pointCount;
  let rgbPacked: Uint8Array;
  if (parsed.rgb.length === pointCount * 3) {
    rgbPacked = repackRgbToRgba(permuteAttribute(parsed.rgb, perm, 3));
  } else {
    // No RGB in this PDRF — fill with gray so shader still has valid buffer
    rgbPacked = new Uint8Array(pointCount * 4);
    for (let i = 0; i < pointCount; i++) {
      rgbPacked[i * 4 + 0] = 128;
      rgbPacked[i * 4 + 1] = 128;
      rgbPacked[i * 4 + 2] = 128;
      rgbPacked[i * 4 + 3] = 255;
    }
  }

  // Destroy old buffers
  positionsBuffer?.destroy();
  intensityBuffer?.destroy();
  rgbBuffer?.destroy();
  classificationBuffer?.destroy();

  positionsBuffer = device.createBuffer({
    label: "las-positions",
    size: scratch.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionsBuffer, 0, scratch);

  intensityBuffer = device.createBuffer({
    label: "las-intensity",
    size: intensityPacked.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(intensityBuffer, 0, intensityPacked);

  rgbBuffer = device.createBuffer({
    label: "las-rgb",
    size: rgbPacked.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(rgbBuffer, 0, rgbPacked);

  classificationBuffer = device.createBuffer({
    label: "las-classification",
    size: classPacked.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(classificationBuffer, 0, classPacked);

  // White bind group (Ward 20 — only positions)
  whiteBindGroup = device.createBindGroup({
    label: "las-white-bg",
    layout: pointPipeline.bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: positionsBuffer } }],
  });

  // Colored bind group (Ward 22 + Ward 23 — 8 bindings incl. size uniform)
  coloredBindGroup = device.createBindGroup({
    label: "las-colored-bg",
    layout: coloredPipeline.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: positionsBuffer } },
      { binding: 1, resource: { buffer: intensityBuffer } },
      { binding: 2, resource: { buffer: rgbBuffer } },
      { binding: 3, resource: { buffer: classificationBuffer } },
      { binding: 4, resource: rampTexture!.createView({ dimension: "1d" }) },
      { binding: 5, resource: sampler! },
      { binding: 6, resource: { buffer: uniformBuffer! } },
      { binding: 7, resource: { buffer: sizeUniformBuffer! } },
    ],
  });

  currentPointCount = pointCount;
  updateRampAndUniform(currentUiMode);
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

  pointPipeline = await compilePointPipeline(device, format);
  coloredPipeline = await compileColoredPointPipeline(device, format);

  depthTexture = device.createTexture({
    label: "las-depth",
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Pre-create ramp texture (256×1 RGBA8) — content swapped via writeTexture on mode change
  rampTexture = uploadColorRamp(device, VIRIDIS_RAMP);
  sampler = device.createSampler({
    magFilter: "linear", minFilter: "linear",
    addressModeU: "clamp-to-edge",
  });
  uniformBuffer = device.createBuffer({
    label: "color-mode-uniform",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  sizeUniformBuffer = device.createBuffer({
    label: "size-uniform",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  viewportPx = canvas.width;
  writeSizeUniform();

  const fileNameEl = document.getElementById("file-name")!;
  const pointCountEl = document.getElementById("point-count")!;
  const parseTimeEl = document.getElementById("parse-time")!;
  const fpsEl = document.getElementById("fps")!;
  const modeSelect = document.getElementById("mode-select") as HTMLSelectElement;
  const sizeSlider = document.getElementById("size-slider") as HTMLInputElement;
  const sizeValueEl = document.getElementById("size-value")!;
  const batchCountEl = document.getElementById("batch-count")!;
  const densityFactorEl = document.getElementById("density-factor")!;

  modeSelect.addEventListener("change", () => {
    currentUiMode = modeSelect.value as UiMode;
    updateRampAndUniform(currentUiMode);
  });

  sizeSlider.addEventListener("input", () => {
    baseSizePx = parseFloat(sizeSlider.value);
    sizeValueEl.textContent = baseSizePx.toFixed(1);
    writeSizeUniform();
  });
  batchCountEl.textContent = "—";

  canvas.addEventListener("dragover", e => e.preventDefault());
  canvas.addEventListener("drop", async e => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    fileNameEl.textContent = `${file.name} (${(file.size / 1e6).toFixed(1)} MB)`;
    try {
      const data = await file.arrayBuffer();
      const head = new Uint8Array(data, 0, Math.min(32, data.byteLength));
      const hex = Array.from(head).map(b => b.toString(16).padStart(2, "0")).join(" ");
      console.log(`[las-smoke] first 32 bytes hex: ${hex}`);
      if (head[0] !== 0x4c || head[1] !== 0x41 || head[2] !== 0x53 || head[3] !== 0x46) {
        const got = String.fromCharCode(head[0] ?? 0, head[1] ?? 0, head[2] ?? 0, head[3] ?? 0);
        showError(`Filen starter ikke med "LASF" magic — fik "${got}". Er det en gyldig LAS-fil?`);
        return;
      }
      const r = await parseLas(data);
      // Ward 25: LAZ dekomprimeres i Rust, så komprimeret input kræver
      // ingen særbehandling her — vi viser det blot i HUD'en.
      const label = r.compressed ? "LAZ" : "LAS";
      pointCountEl.textContent = `${r.pointCount.toLocaleString("da-DK")} (${label})`;
      parseTimeEl.textContent = `${r.parseMs.toFixed(0)}ms (${(r.pointCount / r.parseMs).toFixed(0)} points/ms)`;
      await uploadScene(r);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  document.getElementById("generate-btn")!.addEventListener("click", async () => {
    fileNameEl.textContent = `synthetic helix (${POINT_COUNT_SYNTH} points, PDRF 3)`;
    try {
      const data = generateSyntheticLas(POINT_COUNT_SYNTH);
      const r = await parseLas(data);
      pointCountEl.textContent = r.pointCount.toLocaleString("da-DK");
      parseTimeEl.textContent = `${r.parseMs.toFixed(0)}ms (${(r.pointCount / r.parseMs).toFixed(0)} points/ms)`;
      await uploadScene(r);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") rotationPaused = !rotationPaused;
  });

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

    if (positionsBuffer && normalizedSource && scratch && currentPointCount > 0) {
      throttler.recordFrame();
      densityFactorEl.textContent = throttler.factor().toFixed(2);
      writeSizeUniform();

      // CPU rotation: re-upload roterede positions per frame.
      // GPU-side rotation forsøgt men brækkede ved 10M+ points (præsentations-
      // latency / hak-hak). CPU-path er langsommere på papir men producerer
      // jævn frame-pacing.
      if (!rotationPaused) {
        rotationAngle += dt * 0.0005;
        rotateY(scratch, normalizedSource, rotationAngle);
        device!.queue.writeBuffer(positionsBuffer, 0, scratch);
      }
      const encoder = device!.createCommandEncoder({ label: "las-smoke-encoder" });

      if (currentUiMode === "white") {
        encodePointRenderPass(encoder, pointPipeline!, {
          mode: RENDER_MODE_POINTS,
          pointCount: currentPointCount,
          colorView: context!.getCurrentTexture().createView(),
          depthView: depthTexture!.createView(),
          bindGroup: whiteBindGroup!,
          radixSort: radixStub,
        });
      } else {
        // Ward 23 colored pipeline: triangle-list quad-billboards (6 vertices/point)
        const pass = encoder.beginRenderPass({
          label: "las-colored-pass",
          colorAttachments: [{
            view: context!.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear", storeOp: "store",
          }],
          depthStencilAttachment: {
            view: depthTexture!.createView(),
            depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
          },
        });
        pass.setPipeline(coloredPipeline!.pipeline);
        // Én delt bind group for alle batches — kun draw-range varierer.
        pass.setBindGroup(0, coloredBindGroup!);

        // Rotationen ligger i positionerne (CPU-path), så AABB'erne ville være
        // forældede efter første frame. I stedet foldes den ind i frustummet:
        // planes udtrækkes fra VIEW_PROJ · rotY(angle), og batchene testes i
        // deres egen uroterede model-space.
        const vpModel = multiplyMat4(VIEW_PROJ_MATRIX, rotationMatrixY(rotationAngle));
        const planes = flattenPlanes(extractFrustumPlanes(vpModel));
        const plan = planBatchDraws(sceneBatches, planes);
        for (const range of plan.ranges) {
          const { vertexCount, firstVertex } = drawArgsFor(range);
          pass.draw(vertexCount, 1, firstVertex, 0);
        }
        pass.end();
        batchCountEl.textContent =
          `${plan.visibleBatches}/${plan.totalBatches} batches · ` +
          `${plan.drawnPoints.toLocaleString("da-DK")}/${plan.totalPoints.toLocaleString("da-DK")} pts · ` +
          `${plan.ranges.length} draws`;
      }
      device!.queue.submit([encoder.finish()]);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  console.log("[las-smoke] Ward 21+22+25 ready — drop .las or .laz, or click generate");
}

main().catch(err => showError(err instanceof Error ? err.message : String(err)));
