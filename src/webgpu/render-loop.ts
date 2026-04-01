/**
 * Render loop and frame encoding for splat rendering.
 *
 * Provides a requestAnimationFrame-based loop and a single-frame
 * render function that encodes GPU commands.
 */

import type { SplatRenderPipeline } from "./render-pipeline.js";
import type { GpuSplatBuffer } from "./gpu-buffer.js";

export interface RenderLoop {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

/**
 * Create a render loop that calls `renderFn` every frame via requestAnimationFrame.
 */
export function createRenderLoop(renderFn: (timestamp: number) => void): RenderLoop {
  let running = false;
  let rafId = 0;

  function tick(timestamp: number) {
    if (!running) return;
    renderFn(timestamp);
    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    isRunning() {
      return running;
    },
  };
}

/**
 * Encode and submit one frame of splat rendering.
 *
 * Creates a command encoder, begins a render pass on the current canvas texture,
 * draws instanced billboard quads, and submits to the GPU queue.
 */
export function renderFrame(
  device: GPUDevice,
  context: GPUCanvasContext,
  pipeline: SplatRenderPipeline,
  splatBuffer: GpuSplatBuffer,
): void {
  const textureView = context.getCurrentTexture().createView();

  const encoder = device.createCommandEncoder({ label: "splat-frame" });

  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: textureView,
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: splatBuffer.buffer } },
    ],
  });

  pass.setPipeline(pipeline.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(4, splatBuffer.splatCount); // 4 verts per quad, N instances
  pass.end();

  device.queue.submit([encoder.finish()]);
}
