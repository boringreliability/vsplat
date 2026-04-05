/**
 * Depth key compute shader for radix sort.
 *
 * Computes camera-space depth per splat and encodes as sortable uint32.
 * Output is written to the sortKeys buffer for use by encodeSortGlobal.
 *
 * Uses the same floatToSortableUint bit-manipulation as radix-sort-cpu.ts:
 *   if (sign bit set) → XOR all bits
 *   else → XOR sign bit only
 * Then inverts for descending sort (farthest first for back-to-front).
 */

export interface DepthKeyPipeline {
  pipeline: GPUComputePipeline;
  paramsBuffer: GPUBuffer;
}

const DEPTH_KEY_WGSL = /* wgsl */ `
struct Camera {
  view: mat4x4f,
  proj: mat4x4f,
  camera_pos: vec3f,
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read_write> sort_keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> indices: array<u32>;
@group(0) @binding(3) var<uniform> camera: Camera;

struct Params {
  count: u32,
};
@group(0) @binding(4) var<uniform> params: Params;

// IEEE 754 float → sortable uint (same as CPU floatToSortableUint)
fn float_to_sortable(f: f32) -> u32 {
  let bits = bitcast<u32>(f);
  // If sign bit is set (negative), flip all bits.
  // Otherwise flip only the sign bit.
  let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
  return bits ^ mask;
}

@compute @workgroup_size(256)
fn compute_depth_keys(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.count) { return; }

  let b = idx * 3u;
  // 3DGS Y-down → negate Y (matches vertex shader convention)
  let pos = vec3f(positions[b], -positions[b + 1u], positions[b + 2u]);

  // Camera-space depth: dot(viewDir, pos - cameraPos)
  // viewDir = -Z axis of view matrix = row 2 negated = -(view[0][2], view[1][2], view[2][2])
  // Simpler: just use view-space Z coordinate
  let view_pos = camera.view * vec4f(pos, 1.0);
  let depth = -view_pos.z; // positive depth (farther = larger)

  // Convert to sortable uint, then invert for descending sort (farthest first)
  let sortable = float_to_sortable(depth);
  sort_keys[idx] = sortable ^ 0xFFFFFFFFu; // invert for descending (back-to-front)

  // Initialize identity index
  indices[idx] = idx;
}
`;

export async function createDepthKeyPipeline(device: GPUDevice): Promise<DepthKeyPipeline> {
  const module = device.createShaderModule({
    code: DEPTH_KEY_WGSL,
    label: "depth-keys",
  });

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "compute_depth_keys" },
  } as GPUComputePipelineDescriptor);

  // Params buffer allocated once, reused every frame via writeBuffer
  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "depth-key-params",
  });

  return { pipeline, paramsBuffer };
}

/**
 * Create a bind group for depth key computation. Call once per scene load.
 * The bind group references buffers that don't change between frames.
 */
export function createDepthKeyBindGroup(
  device: GPUDevice,
  depthPipeline: DepthKeyPipeline,
  positions: GPUBuffer,
  sortKeys: GPUBuffer,
  indices: GPUBuffer,
  cameraBuffer: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: depthPipeline.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: positions } },
      { binding: 1, resource: { buffer: sortKeys } },
      { binding: 2, resource: { buffer: indices } },
      { binding: 3, resource: { buffer: cameraBuffer } },
      { binding: 4, resource: { buffer: depthPipeline.paramsBuffer } },
    ],
  });
}

/**
 * Encode depth key computation + identity index initialization.
 * Zero allocations — uses cached paramsBuffer and pre-created bind group.
 */
export function encodeDepthKeys(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  depthPipeline: DepthKeyPipeline,
  bindGroup: GPUBindGroup,
  splatCount: number,
): void {
  // Update count in cached params buffer (no allocation, just writeBuffer)
  device.queue.writeBuffer(depthPipeline.paramsBuffer, 0, new Uint32Array([splatCount, 0, 0, 0]));

  const pass = encoder.beginComputePass({ label: "depth-keys" });
  pass.setPipeline(depthPipeline.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(splatCount / 256));
  pass.end();
}
