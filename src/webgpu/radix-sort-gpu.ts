/**
 * GPU resources and orchestration for radix sort compute shader.
 *
 * Creates storage buffers, compute pipeline, and encodes multi-pass
 * radix sort dispatches for GPU-accelerated back-to-front splat sorting.
 *
 * NOTE: The WGSL shader is a Single-Workgroup Prototype. It performs a correct
 * local sort within each workgroup tile (histogram → prefix sum → scatter),
 * but a complete solution for >256 elements requires a global prefix sum pass
 * across workgroups. This will be added when real GPU integration tests exist.
 */

export interface SortBuffers {
  /** Sort-key buffer (u32 per splat, sortable-uint encoded) */
  sortKeys: GPUBuffer;
  /** Double-buffered index buffers for ping-pong during radix passes */
  indicesA: GPUBuffer;
  indicesB: GPUBuffer;
  /** Uniform buffer for per-pass parameters (count + shift) */
  params: GPUBuffer;
  /** Number of splats these buffers are sized for */
  splatCount: number;
}

export interface SortPipeline {
  /** The compiled compute pipeline */
  pipeline: GPUComputePipeline;
  /** The compiled shader module */
  shaderModule: GPUShaderModule;
}

const WORKGROUP_SIZE = 256;

/**
 * Create GPU buffers for radix sort.
 *
 * Allocates:
 * - 1× sort-key buffer (u32 per splat, sortable-uint encoded)
 * - 2× index buffers (u32 per splat): double-buffered for ping-pong
 * - 1× params uniform buffer (8 bytes: count u32 + shift u32)
 *
 * @throws If splatCount is not a positive integer
 */
export function createSortBuffers(
  device: GPUDevice,
  splatCount: number,
): SortBuffers {
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new RangeError(
      `splatCount must be a positive integer, got ${splatCount}`,
    );
  }

  const bytesPerElement = 4;
  const bufferSize = splatCount * bytesPerElement;

  const sortKeys = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-keys",
  });

  const indicesA = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-indices-a",
  });

  const indicesB = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-indices-b",
  });

  const params = device.createBuffer({
    size: 8, // 2× u32: count + shift
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "sort-params",
  });

  return { sortKeys, indicesA, indicesB, params, splatCount };
}

/**
 * Single-Workgroup Prototype — WGSL compute shader for one radix sort pass.
 *
 * Each dispatch performs one 8-bit radix pass within each workgroup tile:
 *   Phase 1: Clear local histogram
 *   Phase 2: Count digit occurrences (atomics)
 *   Phase 3: Exclusive prefix sum over 256 buckets (serial, thread 0)
 *   Phase 4: Scatter — atomicAdd on local_prefix for unique destinations
 *
 * LIMITATION: This sorts correctly WITHIN each 256-element tile, but does
 * NOT produce a globally sorted output across multiple workgroups. A complete
 * implementation requires an additional global prefix sum pass to compute
 * cross-workgroup offsets. This is acceptable for pipeline validation; the
 * CPU reference (radix-sort-cpu.ts) handles correctness for now.
 */
const RADIX_SORT_WGSL = /* wgsl */ `
// Single-Workgroup Prototype: sorts within each 256-element tile.
// A global prefix sum pass is needed for cross-workgroup correctness.

const WORKGROUP_SIZE: u32 = 256u;
const RADIX_BUCKETS: u32 = 256u;

@group(0) @binding(0) var<storage, read> sort_keys: array<u32>;
@group(0) @binding(1) var<storage, read> indices_in: array<u32>;
@group(0) @binding(2) var<storage, read_write> indices_out: array<u32>;

struct Params {
  count: u32,
  shift: u32,
};

@group(0) @binding(3) var<uniform> params: Params;

// Per-workgroup histogram: count of each digit value (0-255)
var<workgroup> local_histogram: array<atomic<u32>, 256>;
// Per-workgroup prefix sums: exclusive scan over histogram for scatter offsets
var<workgroup> local_prefix: array<atomic<u32>, 256>;

@compute @workgroup_size(256)
fn radix_sort_pass(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let global_idx = gid.x;
  let local_idx = lid.x;
  let tile_offset = wid.x * WORKGROUP_SIZE;

  // Phase 1: Clear local histogram and prefix
  if (local_idx < RADIX_BUCKETS) {
    atomicStore(&local_histogram[local_idx], 0u);
    atomicStore(&local_prefix[local_idx], 0u);
  }
  workgroupBarrier();

  // Phase 2: Count digit occurrences within this workgroup's tile
  var my_digit: u32 = 0u;
  var my_key_idx: u32 = 0u;
  var is_valid: bool = global_idx < params.count;
  if (is_valid) {
    my_key_idx = indices_in[global_idx];
    let key = sort_keys[my_key_idx];
    my_digit = (key >> params.shift) & 0xFFu;
    atomicAdd(&local_histogram[my_digit], 1u);
  }
  workgroupBarrier();

  // Phase 3: Workgroup-local exclusive prefix sum over histogram
  // Serial scan by thread 0 — 256 iterations is trivial for one thread.
  if (local_idx == 0u) {
    var running_total: u32 = 0u;
    for (var i: u32 = 0u; i < RADIX_BUCKETS; i = i + 1u) {
      let count = atomicLoad(&local_histogram[i]);
      atomicStore(&local_prefix[i], running_total);
      running_total = running_total + count;
    }
  }
  workgroupBarrier();

  // Phase 4: Scatter — each thread claims a unique destination via atomicAdd
  // on its digit's prefix counter, producing a locally sorted tile.
  if (is_valid) {
    let dest = atomicAdd(&local_prefix[my_digit], 1u);
    indices_out[tile_offset + dest] = my_key_idx;
  }
}
`;

/**
 * Create the radix sort compute pipeline.
 *
 * @throws If shader compilation produces errors
 */
export async function createSortPipeline(
  device: GPUDevice,
): Promise<SortPipeline> {
  const shaderModule = device.createShaderModule({
    code: RADIX_SORT_WGSL,
    label: "radix-sort-shader",
  });

  // Validate shader compilation
  const compilationInfo = await shaderModule.compilationInfo();
  const errors = compilationInfo.messages.filter(
    (m: { type: string }) => m.type === "error",
  );
  if (errors.length > 0) {
    const details = errors
      .map((e: { message: string }) => e.message)
      .join("; ");
    throw new Error(`Radix sort shader compilation failed: ${details}`);
  }

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: shaderModule,
      entryPoint: "radix_sort_pass",
    },
  } as GPUComputePipelineDescriptor);

  return { pipeline, shaderModule };
}

/**
 * Encode 4 radix sort passes into a command encoder.
 *
 * Each pass sorts by an 8-bit digit (shift 0, 8, 16, 24).
 * Uses ping-pong between indicesA and indicesB: pass reads from one,
 * writes to the other, then swaps for the next pass.
 *
 * Returns the GPUBuffer containing the final sorted indices.
 * After 4 passes (even number of swaps), the result is always in indicesA.
 */
export function encodeSort(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipeline: SortPipeline,
  buffers: SortBuffers,
): GPUBuffer {
  const workgroupCount = Math.ceil(buffers.splatCount / WORKGROUP_SIZE);
  const paramsData = new Uint32Array(2);

  let readBuffer = buffers.indicesA;
  let writeBuffer = buffers.indicesB;

  for (let pass = 0; pass < 4; pass++) {
    const shift = pass * 8;

    // Write params: [count, shift]
    paramsData[0] = buffers.splatCount;
    paramsData[1] = shift;
    device.queue.writeBuffer(buffers.params, 0, paramsData);

    // Create bind group for this pass
    const bindGroup = device.createBindGroup({
      layout: pipeline.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.sortKeys } },
        { binding: 1, resource: { buffer: readBuffer } },
        { binding: 2, resource: { buffer: writeBuffer } },
        { binding: 3, resource: { buffer: buffers.params } },
      ],
    });

    // Dispatch compute
    const computePass = encoder.beginComputePass({ label: `radix-pass-${pass}` });
    computePass.setPipeline(pipeline.pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(workgroupCount);
    computePass.end();

    // Ping-pong: swap read/write buffers
    [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
  }

  return buffers.indicesA;
}
