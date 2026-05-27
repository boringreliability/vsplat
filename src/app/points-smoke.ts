/**
 * Ward 20 — Standalone smoke-test entry point.
 *
 * Renderer 10,000 syntetiske torus-overflade-points via Ward 20's point-pipeline.
 * Ingen Worker, ingen Wasm, ingen ECS, ingen PLY-parsing — kun det Ward 20 leverer.
 *
 * Visuel succes-kriterium:
 *   - 3D torus-form synlig (ringen er klart visibel)
 *   - Forsiden skjuler bagsiden under rotation (depth-test virker)
 *   - 'M' toggler RENDER_MODE — splats-mode logger radixSort.dispatch i konsol
 */

import {
  compilePointPipeline,
  encodePointRenderPass,
  RENDER_MODE_POINTS,
  RENDER_MODE_SPLATS,
  type RenderMode,
} from "../webgpu/point-pipeline.js";

const POINT_COUNT = 50_000;
const TORUS_R = 0.55; // major radius
const TORUS_r = 0.2; // minor radius
const TILT_ANGLE = (Math.PI * 60) / 180; // 60° tilt around X so we see the ring obliquely

function showError(msg: string): void {
  const el = document.getElementById("error")!;
  el.textContent = msg;
  el.style.display = "block";
  console.error("[smoke]", msg);
}

function generateTorusPoints(count: number): Float32Array {
  const positions = new Float32Array(count * 3);
  const ct = Math.cos(TILT_ANGLE), st = Math.sin(TILT_ANGLE);
  for (let i = 0; i < count; i++) {
    // Sample ring uniformly via two independent angles
    const u = (i / count) * Math.PI * 2; // around major ring
    const v = (i * 1.618 * Math.PI * 2) % (Math.PI * 2); // around tube
    const cu = Math.cos(u), su = Math.sin(u);
    const cv = Math.cos(v), sv = Math.sin(v);
    const w = TORUS_R + TORUS_r * cv;
    // Base torus in X-Y plane (donut hole along Z)
    const x0 = w * cu;
    const y0 = w * su;
    const z0 = TORUS_r * sv;
    // Tilt around X axis so front-arc and back-arc are clearly separated in Z
    positions[i * 3 + 0] = x0;
    positions[i * 3 + 1] = ct * y0 - st * z0;
    positions[i * 3 + 2] = st * y0 + ct * z0;
  }
  return positions;
}

function rotateY(positions: Float32Array, sourcePositions: Float32Array, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < sourcePositions.length; i += 3) {
    const x = sourcePositions[i]!;
    const z = sourcePositions[i + 2]!;
    positions[i] = c * x + s * z;
    positions[i + 1] = sourcePositions[i + 1]!;
    positions[i + 2] = -s * x + c * z;
  }
}

async function main(): Promise<void> {
  if (!navigator.gpu) {
    showError("WebGPU er ikke tilgængelig i denne browser.");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    showError("Ingen GPU adapter fundet.");
    return;
  }
  const device = await adapter.requestDevice();

  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  // 1. Compile Ward 20 pipeline
  const pipeline = await compilePointPipeline(device, format);

  // 2. Allokér positions storage buffer
  const sourcePositions = generateTorusPoints(POINT_COUNT);
  const rotatedPositions = new Float32Array(sourcePositions.length);
  rotatedPositions.set(sourcePositions);

  const positionsBuffer = device.createBuffer({
    label: "smoke-positions",
    size: rotatedPositions.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionsBuffer, 0, rotatedPositions);

  // 3. Allokér depth-stencil texture (matcher pipeline's depth24plus format)
  let depthTexture = device.createTexture({
    label: "smoke-depth",
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // 4. Bind group der peger på positions-buffer
  const bindGroup = device.createBindGroup({
    label: "smoke-bg",
    layout: pipeline.bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: positionsBuffer } }],
  });

  // 5. Radix-sort stub — logger når den ville være blevet kaldt
  const radixSort = {
    dispatch: () => {
      if (mode === RENDER_MODE_SPLATS) {
        console.log("[smoke] radixSort.dispatch() called (splats-mode)");
      }
    },
  };

  // 6. State
  let mode: RenderMode = RENDER_MODE_POINTS;
  let rotationAngle = 0;
  let rotationPaused = false;
  let lastFrameTime = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;

  const modeLabel = document.getElementById("mode-label")!;
  const fpsLabel = document.getElementById("fps")!;

  // 7. Keyboard controls
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "m") {
      mode = mode === RENDER_MODE_POINTS ? RENDER_MODE_SPLATS : RENDER_MODE_POINTS;
      modeLabel.textContent = mode;
      console.log(`[smoke] mode → ${mode}`);
    } else if (e.key.toLowerCase() === "r") {
      rotationPaused = !rotationPaused;
      console.log(`[smoke] rotation ${rotationPaused ? "paused" : "resumed"}`);
    }
  });

  // 8. Handle resize (recreate depth texture to match)
  const resizeObserver = new ResizeObserver(() => {
    const w = canvas.clientWidth * devicePixelRatio;
    const h = canvas.clientHeight * devicePixelRatio;
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    depthTexture.destroy();
    depthTexture = device.createTexture({
      label: "smoke-depth",
      size: [canvas.width, canvas.height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  });
  resizeObserver.observe(canvas);

  // 9. Render loop
  function frame(): void {
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    fpsAccum += dt;
    fpsFrames++;
    if (fpsFrames >= 30) {
      fpsLabel.textContent = `${(1000 / (fpsAccum / fpsFrames)).toFixed(0)}`;
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (!rotationPaused) {
      rotationAngle += dt * 0.0005;
      rotateY(rotatedPositions, sourcePositions, rotationAngle);
      device.queue.writeBuffer(positionsBuffer, 0, rotatedPositions);
    }

    const encoder = device.createCommandEncoder({ label: "smoke-encoder" });
    encodePointRenderPass(encoder, pipeline, {
      mode,
      pointCount: POINT_COUNT,
      colorView: context.getCurrentTexture().createView(),
      depthView: depthTexture.createView(),
      bindGroup,
      radixSort,
    });
    device.queue.submit([encoder.finish()]);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  console.log("[smoke] Ward 20 smoke-test ready — M=toggle mode, R=pause rotation");
}

main().catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
});
