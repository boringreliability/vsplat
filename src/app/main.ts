/**
 * vsplat — First Light entry point.
 *
 * Thin app shell that INTEGRATES existing modules.
 * No inline shaders, no inline buffer creation, no inline camera math.
 * All rendering, GPU, and shader logic lives in the modules built in Wards 1-17.
 */

import { checkCapabilities } from "../errors/capability-gate.js";
import { checkSceneMemory } from "../errors/memory-pressure.js";
import { type VsplatError } from "../errors/vsplat-error.js";
import { createWorkerBridge, type WorkerBridge } from "../worker/bridge.js";
import { OrbitController } from "../camera/orbit.js";
import { CameraSystem } from "../camera/system.js";
import { compileSplatShader, type SplatShaderPipeline } from "../webgpu/splat-shader.js";
import { createGpuSplatBuffer, uploadSplatBuffer } from "../webgpu/gpu-buffer.js";
import { createGpuSHBuffer, uploadSHBuffer } from "../webgpu/sh-buffer.js";
import { createGpuOpacityBuffer, uploadOpacityBuffer } from "../webgpu/opacity-buffer.js";
import { createWasmMemoryView } from "../webgpu/wasm-memory.js";
import {
  createGlobalSortBuffers, createGlobalSortPipelines, encodeSortGlobal,
  type GlobalSortBuffers, type GlobalSortPipelines,
} from "../webgpu/radix-sort-global.js";
import {
  createDepthKeyPipeline, createDepthKeyBindGroup, encodeDepthKeys,
  type DepthKeyPipeline,
} from "../webgpu/depth-keys.js";
import {
  createSplatMesh, SPLATS_PER_INSTANCE,
  type SplatMesh,
} from "../webgpu/splat-mesh.js";

// ─── Error Display ───────────────────────────────────────────────

function showError(err: VsplatError): void {
  const el = document.getElementById("error");
  if (el) { el.textContent = err.message; el.style.display = "block"; }
  console.error(`[vsplat] ${err.code}: ${err.message}`, err.details ?? "");
}

// ─── Main ────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // 1. Capability gate (Ward 17)
  const caps = checkCapabilities();
  if (caps.error) { showError(caps.error); return; }
  caps.warnings.forEach(w => console.warn(`[vsplat] ${w.code}: ${w.message}`));

  // 2. WebGPU init
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { showError({ code: "UNSUPPORTED_WEBGPU", message: "No GPU adapter.", recoverable: false } as VsplatError); return; }

  const features: GPUFeatureName[] = [];
  if (adapter.features.has("timestamp-query")) features.push("timestamp-query");

  const device = await adapter.requestDevice({
    requiredFeatures: features,
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
  context.configure({ device, format, alphaMode: "premultiplied" });

  // 3. Worker bridge (Ward 15)
  const wasmUrl = new URL("/vsplat_core.js", window.location.origin).href;
  let bridge: WorkerBridge;
  try {
    bridge = await createWorkerBridge(wasmUrl, {
      worker: new Worker(new URL("../worker/wasm-worker.ts", import.meta.url), { type: "module" }),
      timeouts: { init: 15_000, loadPly: 60_000, getBuffers: 15_000, ping: 5_000 },
    });
  } catch (err) { showError(err as VsplatError); return; }
  console.log("[vsplat] Worker bridge ready");

  // 4. Camera (Ward 8)
  const orbit = new OrbitController({ target: [0, 0, 0], distance: 5, azimuth: 0, elevation: 0 });
  const camera = new CameraSystem(device, {
    fov: Math.PI / 4, aspect: canvas.width / canvas.height, near: 0.01, far: 1000,
  });
  camera.setViewport(canvas.width, canvas.height);
  // Focal is auto-derived from projection matrix in uploadToGPU()

  // 5. Compile shader (Ward 7)
  let splatPipeline: SplatShaderPipeline;
  try {
    splatPipeline = await compileSplatShader(device, format);
  } catch (err) { showError(err as VsplatError); return; }

  // 5b. Instanced splat mesh (128 quads per instance — PlayCanvas pattern)
  const splatMesh = createSplatMesh(device);

  // 6. Mouse controls
  let isDragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("mousedown", e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener("mouseup", () => { isDragging = false; });
  window.addEventListener("mousemove", e => {
    if (!isDragging) return;
    orbit.rotate((e.clientX - lastX) * 0.005, (e.clientY - lastY) * 0.005);
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener("wheel", e => { e.preventDefault(); orbit.zoom(e.deltaY * 0.01); }, { passive: false });

  // 7. Scene state
  let splatCount = 0;
  let cachedPositions: Float32Array | null = null;
  let posBuffer: ReturnType<typeof createGpuSplatBuffer> | null = null;
  let shBuffer: ReturnType<typeof createGpuSHBuffer> | null = null;
  let opBuffer: ReturnType<typeof createGpuOpacityBuffer> | null = null;
  let rotBuffer: GPUBuffer | null = null;
  let scBuffer: GPUBuffer | null = null;
  let sortBuffers: GlobalSortBuffers | null = null;
  let sortPipelines: GlobalSortPipelines | null = null;
  let depthKeyPipeline: DepthKeyPipeline | null = null;
  let cachedDepthKeyBindGroup: GPUBindGroup | null = null;
  let cachedDataBindGroup: GPUBindGroup | null = null;
  let cachedCameraBindGroup: GPUBindGroup | null = null;
  let pendingSortResult: Uint32Array | null = null;
  let sortInFlight = false;

  // 8. Drag-and-drop → load scene
  canvas.addEventListener("dragover", e => e.preventDefault());
  canvas.addEventListener("drop", async e => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    console.log(`[vsplat] Loading ${file.name} (${(file.size / 1e6).toFixed(1)}MB)`);

    const memCheck = checkSceneMemory(Math.floor(file.size / 236), 48);
    if (memCheck) { showError(memCheck); return; }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const { splatCount: count } = await bridge.loadPly(arrayBuffer);
      splatCount = count;
      console.log(`[vsplat] Loaded ${splatCount} splats`);

      const buffers = await bridge.getBuffers();
      cachedPositions = buffers.positions; // keep for CPU sort
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

      // GPU buffers via existing modules (Ward 5, 14)
      posBuffer = createGpuSplatBuffer(device, splatCount);
      device.queue.writeBuffer(posBuffer.buffer, 0, buffers.positions);

      shBuffer = createGpuSHBuffer(device, splatCount, buffers.shDim);
      device.queue.writeBuffer(shBuffer.buffer, 0, buffers.sh);

      opBuffer = createGpuOpacityBuffer(device, splatCount);
      device.queue.writeBuffer(opBuffer.buffer, 0, buffers.opacities);

      rotBuffer = device.createBuffer({ size: buffers.rotations.byteLength, usage, label: "rotations" });
      device.queue.writeBuffer(rotBuffer, 0, buffers.rotations);

      scBuffer = device.createBuffer({ size: buffers.scales.byteLength, usage, label: "scales" });
      device.queue.writeBuffer(scBuffer, 0, buffers.scales);

      // Sort buffers + pipelines (Ward 12)
      sortBuffers = createGlobalSortBuffers(device, splatCount);
      sortPipelines = await createGlobalSortPipelines(device);

      // Depth key pipeline + bind group (cached, zero alloc per frame)
      depthKeyPipeline = await createDepthKeyPipeline(device);
      cachedDepthKeyBindGroup = createDepthKeyBindGroup(
        device, depthKeyPipeline,
        posBuffer.buffer, sortBuffers.sortKeys, sortBuffers.indicesA,
        camera.getBuffer(),
      );

      // Cap SH to degree 1 for performance — degree 2-3 adds minimal visual quality
      const shBands = Math.min(1, buffers.shDim >= 48 ? 3 : buffers.shDim >= 27 ? 2 : buffers.shDim >= 12 ? 1 : 0);
      camera.setSH(shBands, buffers.shDim);
      console.log(`[vsplat] SH: degree ${shBands}, dim ${buffers.shDim}`);

      // Cache bind groups (created once per scene load, not per frame)
      cachedDataBindGroup = device.createBindGroup({
        layout: splatPipeline.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: posBuffer.buffer } },
          { binding: 1, resource: { buffer: rotBuffer } },
          { binding: 2, resource: { buffer: scBuffer } },
          { binding: 3, resource: { buffer: opBuffer.buffer } },
          { binding: 4, resource: { buffer: shBuffer.buffer } },
          { binding: 5, resource: { buffer: sortBuffers.indicesA } },
        ],
      });
      cachedCameraBindGroup = device.createBindGroup({
        layout: splatPipeline.pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: camera.getBuffer() } },
        ],
      });

      const maxDraw = 500_000;
      console.log(`[vsplat] Scene ready: ${splatCount} splats, rendering ${Math.min(splatCount, maxDraw)}, sort on camera change`);
    } catch (err) { showError(err as VsplatError); }
  });

  // 9. FPS counter
  const fpsEl = document.createElement("div");
  fpsEl.id = "fps";
  fpsEl.style.cssText = "position:fixed;top:4px;right:8px;color:#fff;font:12px monospace;z-index:100;opacity:0.7";
  document.body.appendChild(fpsEl);
  let frameCount = 0;
  let fpsAccum = 0;
  let lastFrameTime = performance.now();

  // 10. Camera change detection (skip sort when static)
  let lastEye: [number, number, number] = [0, 0, 0];
  let lastTarget: [number, number, number] = [0, 0, 0];
  let needsSort = true; // sort on first frame after load

  function cameraChanged(eye: [number, number, number], target: [number, number, number]): boolean {
    const eps = 1e-6;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(eye[i] - lastEye[i]) > eps) return true;
      if (Math.abs(target[i] - lastTarget[i]) > eps) return true;
    }
    return false;
  }

  // 11. Render loop
  function frame(): void {
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    fpsAccum += dt;
    frameCount++;
    if (frameCount >= 60) {
      const avgMs = fpsAccum / frameCount;
      const fps = 1000 / avgMs;
      fpsEl.textContent = `${fps.toFixed(0)} fps | ${avgMs.toFixed(1)}ms | ${splatCount} splats`;
      frameCount = 0;
      fpsAccum = 0;
    }

    const eye = orbit.getPosition();
    const target = orbit.getTarget();

    // Camera update (Ward 8)
    camera.setView(eye, target, [0, 1, 0]);
    camera.uploadToGPU();

    // Detect camera movement → only sort when needed
    if (cameraChanged(eye, target)) {
      needsSort = true;
      lastEye = [...eye];
      lastTarget = [...target];
    }

    if (cachedDataBindGroup && splatCount > 0) {
      const encoder = device.createCommandEncoder();

      // Rust/Wasm counting sort — fire-and-forget, never await in render loop
      if (needsSort && !sortInFlight) {
        sortInFlight = true;
        needsSort = false;
        // Camera direction = normalize(target - eye)
        const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
        const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        bridge.sortByDepth(eye[0], eye[1], eye[2], dx / dlen, dy / dlen, dz / dlen).then(result => {
          pendingSortResult = result;
          sortInFlight = false;
        }).catch(() => { sortInFlight = false; });
      }

      // Upload sort result when ready (non-blocking)
      if (pendingSortResult && sortBuffers) {
        device.queue.writeBuffer(sortBuffers.indicesA, 0, pendingSortResult);
        pendingSortResult = null;
      }

      const textureView = context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.05, g: 0.05, b: 0.1, a: 0.0 },
        }],
      });

      pass.setPipeline(splatPipeline.pipeline);
      pass.setVertexBuffer(0, splatMesh.vertexBuffer);
      pass.setIndexBuffer(splatMesh.indexBuffer, "uint32");
      pass.setBindGroup(0, cachedDataBindGroup);
      pass.setBindGroup(1, cachedCameraBindGroup!);
      // 768 indices per instance, ceil(splatCount/128) instances
      pass.drawIndexed(splatMesh.indexCount, Math.ceil(splatCount / SPLATS_PER_INSTANCE));
      pass.end();

      device.queue.submit([encoder.finish()]);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  console.log("[vsplat] First Light ready — drop a PLY file onto the canvas");
}

main().catch(console.error);
