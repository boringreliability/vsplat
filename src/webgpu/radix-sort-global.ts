/**
 * Global GPU Radix Sort — 3-pass architecture for production-grade sorting.
 *
 * Replaces the Single-Workgroup Prototype (Ward 6) with a globally correct
 * sort using multi-level prefix sum. Supports datasets up to 2^23 (8M splats)
 * via recursive scan: Level 1 scans histogram tiles, Level 2 scans the
 * auxiliary buffer (up to 2048 entries for 8M splats), Level 3 handles
 * the second auxiliary if needed (≤8 entries). Beyond 8M splats, the
 * scan would require a 4th level — not currently implemented.
 *
 * Architecture: 8 radix passes (4-bit digit each) × GPU dispatches per pass:
 *   1. Count (Histogram): per-workgroup digit counts → global histogram
 *   2. Scan (Prefix Sum): multi-level exclusive prefix sum over histogram
 *   3. Scatter: globally correct element placement using prefix offsets
 *
 * GPU-specific design divergence from CPU reference:
 *   CPU uses 8-bit radix (256 buckets, 4 passes).
 *   GPU uses 4-bit radix (16 buckets, 8 passes).
 *   This halves scan complexity (16× fewer elements) at the cost of 2× passes.
 *   Ordering semantics target CPU oracle equivalence. Stability is empirically
 *   observed on current hardware but not formally guaranteed by WGSL spec.
 *   Browser integration tests (Ward 17) will verify GPU-side stability.
 *
 * Histogram uses column-major layout: histogram[digit * numWorkgroups + wg_id].
 * This places all workgroup contributions for a single digit contiguously,
 * enabling efficient sequential scan in Pass 2.
 */

export const WORKGROUP_SIZE = 256;
const RADIX_BITS = 4;
const RADIX_BUCKETS = 1 << RADIX_BITS; // 16
const RADIX_PASSES = 32 / RADIX_BITS;  // 8

// ─── Types ───────────────────────────────────────────────────────

export interface GlobalSortBuffers {
  sortKeys: GPUBuffer;
  indicesA: GPUBuffer;
  indicesB: GPUBuffer;
  histogram: GPUBuffer;
  scanAux: GPUBuffer;
  scanAux2: GPUBuffer;
  scanAux3: GPUBuffer;
  params: GPUBuffer;
  splatCount: number;
}

export interface GlobalSortPipelines {
  count: GPUComputePipeline;
  scan: GPUComputePipeline;
  scanAddBack: GPUComputePipeline;
  scatter: GPUComputePipeline;
}

// ─── Buffer Creation ─────────────────────────────────────────────

/**
 * Allocate all GPU buffers for global radix sort.
 *
 * @throws RangeError if splatCount is not a positive integer
 */
export function createGlobalSortBuffers(
  device: GPUDevice,
  splatCount: number,
): GlobalSortBuffers {
  if (!Number.isInteger(splatCount) || splatCount <= 0) {
    throw new RangeError(`splatCount must be a positive integer, got ${splatCount}`);
  }

  const numWorkgroups = Math.ceil(splatCount / WORKGROUP_SIZE);
  const histogramElements = numWorkgroups * RADIX_BUCKETS;
  const scanAuxElements = Math.ceil(histogramElements / WORKGROUP_SIZE);
  // Level 3: for 8M splats, scanAux can be ~2048 entries → scanAux2 = ceil(2048/256) = 8
  const scanAux2Elements = Math.ceil(scanAuxElements / WORKGROUP_SIZE);

  // Guard against silent corruption: if scanAux2 exceeds one workgroup,
  // the 3-level scan produces wrong prefix sums without any visible error.
  if (scanAux2Elements > WORKGROUP_SIZE) {
    throw new RangeError(
      `Dataset too large for 3-level scan: ${splatCount} splats requires ` +
      `${scanAux2Elements} level-3 elements (max ${WORKGROUP_SIZE}). ` +
      `A 4th scan level is not implemented.`,
    );
  }

  const sortKeys = device.createBuffer({
    size: splatCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-keys",
  });

  const indicesA = device.createBuffer({
    size: splatCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-indices-a",
  });

  const indicesB = device.createBuffer({
    size: splatCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-indices-b",
  });

  const histogram = device.createBuffer({
    size: histogramElements * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-histogram",
  });

  const scanAux = device.createBuffer({
    size: scanAuxElements * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-scan-aux",
  });

  const scanAux2 = device.createBuffer({
    size: Math.max(scanAux2Elements, 1) * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-scan-aux2",
  });

  // Level-3 scan aux: single element, exists solely to honor scan shader's
  // binding contract (binding 1 = aux_out). Never read.
  const scanAux3 = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "sort-scan-aux3",
  });

  const params = device.createBuffer({
    size: 16, // count(u32) + shift(u32) + numWorkgroups(u32) + pad(u32)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "sort-params",
  });

  return { sortKeys, indicesA, indicesB, histogram, scanAux, scanAux2, scanAux3, params, splatCount };
}

// ─── WGSL Shaders ────────────────────────────────────────────────

const COUNT_WGSL = /* wgsl */ `
// Pass 1: Count — per-workgroup digit histogram.
// Column-major output: histogram[digit * numWorkgroups + wg_id]

struct Params { count: u32, shift: u32, num_workgroups: u32, _pad: u32 };
@group(0) @binding(0) var<storage, read> sort_keys: array<u32>;
@group(0) @binding(1) var<storage, read> indices_in: array<u32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> local_counts: array<atomic<u32>, 16>;

@compute @workgroup_size(256)
fn count_pass(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  if (lid.x < 16u) { atomicStore(&local_counts[lid.x], 0u); }
  workgroupBarrier();

  let idx = gid.x;
  if (idx < params.count) {
    let key = sort_keys[indices_in[idx]];
    let digit = (key >> params.shift) & 0xFu;
    atomicAdd(&local_counts[digit], 1u);
  }
  workgroupBarrier();

  if (lid.x < 16u) {
    let count = atomicLoad(&local_counts[lid.x]);
    atomicStore(&histogram[lid.x * params.num_workgroups + wid.x], count);
  }
}
`;

const SCAN_WGSL = /* wgsl */ `
// Pass 2: Scan — workgroup-level Blelloch exclusive prefix sum.
// Each workgroup scans WORKGROUP_SIZE elements of the input data buffer.
// The per-workgroup total is written to aux_out for multi-level aggregation.
// Bounds-safe: out-of-range threads load 0, out-of-range writes are skipped.

@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> aux_out: array<u32>;

var<workgroup> temp: array<u32, 256>;

@compute @workgroup_size(256)
fn scan_pass(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let n = 256u;
  let global_idx = gid.x;
  let data_len = arrayLength(&data);

  // Load input (bounds-safe: 0 for out-of-range)
  temp[lid.x] = select(0u, data[global_idx], global_idx < data_len);
  workgroupBarrier();

  // Blelloch up-sweep (reduce)
  for (var stride: u32 = 1u; stride < n; stride = stride * 2u) {
    let idx = (lid.x + 1u) * stride * 2u - 1u;
    if (idx < n) {
      temp[idx] = temp[idx] + temp[idx - stride];
    }
    workgroupBarrier();
  }

  // Save workgroup total to auxiliary buffer, then zero the last element
  if (lid.x == 0u) {
    aux_out[wid.x] = temp[n - 1u];
    temp[n - 1u] = 0u;
  }
  workgroupBarrier();

  // Blelloch down-sweep (exclusive scan)
  for (var stride: u32 = n / 2u; stride >= 1u; stride = stride / 2u) {
    let idx = (lid.x + 1u) * stride * 2u - 1u;
    if (idx < n) {
      let t = temp[idx - stride];
      temp[idx - stride] = temp[idx];
      temp[idx] = temp[idx] + t;
    }
    workgroupBarrier();
  }

  // Write back (bounds-safe)
  if (global_idx < data_len) {
    data[global_idx] = temp[lid.x];
  }
}
`;

const SCAN_ADD_BACK_WGSL = /* wgsl */ `
// Pass 2b: Add scanned auxiliary totals back to each tile of the data buffer.
// Each thread adds its tile's scanned aux value to the corresponding data element.

@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var<storage, read> scanned_aux: array<u32>;

@compute @workgroup_size(256)
fn scan_add_back(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let data_len = arrayLength(&data);
  let global_idx = gid.x;
  if (global_idx < data_len) {
    data[global_idx] = data[global_idx] + scanned_aux[wid.x];
  }
}
`;

const SCATTER_WGSL = /* wgsl */ `
// Pass 3: Scatter — write each element to its globally correct position.
//
// Stability note: within a workgroup, threads typically execute in gid.x order
// and atomicAdd produces sequential destinations per digit bucket. This makes
// the sort empirically stable on current hardware. However, the WGSL spec does
// not guarantee intra-workgroup execution order, so stability is not formally
// proven. The CPU oracle (radix-sort-cpu.ts) IS stable by construction.
// Full GPU stability verification requires browser integration tests (Ward 17).

struct Params { count: u32, shift: u32, num_workgroups: u32, _pad: u32 };
@group(0) @binding(0) var<storage, read> sort_keys: array<u32>;
@group(0) @binding(1) var<storage, read> indices_in: array<u32>;
@group(0) @binding(2) var<storage, read_write> indices_out: array<u32>;
@group(0) @binding(3) var<storage, read> prefix_sums: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> local_offsets: array<atomic<u32>, 16>;

@compute @workgroup_size(256)
fn scatter_pass(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  if (lid.x < 16u) {
    atomicStore(&local_offsets[lid.x], prefix_sums[lid.x * params.num_workgroups + wid.x]);
  }
  workgroupBarrier();

  let idx = gid.x;
  if (idx < params.count) {
    let key_idx = indices_in[idx];
    let key = sort_keys[key_idx];
    let digit = (key >> params.shift) & 0xFu;
    let dest = atomicAdd(&local_offsets[digit], 1u);
    indices_out[dest] = key_idx;
  }
}
`;

// ─── Pipeline Creation ───────────────────────────────────────────

/**
 * Create the compute pipelines for global radix sort.
 * 4 pipelines: Count, Scan (reused for all scan levels), ScanAddBack, Scatter.
 *
 * @throws If any shader compilation fails
 */
export async function createGlobalSortPipelines(
  device: GPUDevice,
): Promise<GlobalSortPipelines> {
  const shaders = [
    { code: COUNT_WGSL, entry: "count_pass", label: "sort-count" },
    { code: SCAN_WGSL, entry: "scan_pass", label: "sort-scan" },
    { code: SCAN_ADD_BACK_WGSL, entry: "scan_add_back", label: "sort-scan-add-back" },
    { code: SCATTER_WGSL, entry: "scatter_pass", label: "sort-scatter" },
  ];

  const pipelines: GPUComputePipeline[] = [];

  for (const s of shaders) {
    const module = device.createShaderModule({ code: s.code, label: s.label });
    const info = await module.compilationInfo();
    const errors = info.messages.filter((m: { type: string }) => m.type === "error");
    if (errors.length > 0) {
      const details = errors.map((e: { message: string }) => e.message).join("; ");
      throw new Error(`Radix sort shader compilation failed (${s.label}): ${details}`);
    }
    pipelines.push(device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: s.entry },
    } as GPUComputePipelineDescriptor));
  }

  return {
    count: pipelines[0],
    scan: pipelines[1],
    scanAddBack: pipelines[2],
    scatter: pipelines[3],
  };
}

// ─── Multi-Level Scan Helper ─────────────────────────────────────

/**
 * Encode a multi-level exclusive prefix sum over a data buffer.
 *
 * Level 1: Scan tiles of `data` → per-tile totals in `aux`.
 * Level 2: If aux > 1 tile, recursively scan `aux` → totals in `aux2`.
 * Level 3: If aux2 > 1 tile, scan `aux2` in a single workgroup (≤256).
 * Then add scanned totals back down: aux2 → aux → data.
 *
 * Reuses the same scan pipeline for all levels (generic over buffer bindings).
 */
function encodeMultiLevelScan(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GlobalSortPipelines,
  data: GPUBuffer,
  aux: GPUBuffer,
  aux2: GPUBuffer,
  aux3: GPUBuffer,
  dataElements: number,
  passLabel: string,
): void {
  const level1Tiles = Math.ceil(dataElements / WORKGROUP_SIZE);
  const level2Tiles = Math.ceil(level1Tiles / WORKGROUP_SIZE);

  // Level 1: scan data tiles → per-tile totals in aux
  const scan1BG = device.createBindGroup({
    layout: pipelines.scan.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: data } },
      { binding: 1, resource: { buffer: aux } },
    ],
  });
  const scan1 = encoder.beginComputePass({ label: `${passLabel}-scan-L1` });
  scan1.setPipeline(pipelines.scan);
  scan1.setBindGroup(0, scan1BG);
  scan1.dispatchWorkgroups(level1Tiles);
  scan1.end();

  if (level1Tiles > 1) {
    // Level 2: scan aux tiles → per-tile totals in aux2
    const scan2BG = device.createBindGroup({
      layout: pipelines.scan.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aux } },
        { binding: 1, resource: { buffer: aux2 } },
      ],
    });
    const scan2 = encoder.beginComputePass({ label: `${passLabel}-scan-L2` });
    scan2.setPipeline(pipelines.scan);
    scan2.setBindGroup(0, scan2BG);
    scan2.dispatchWorkgroups(level2Tiles);
    scan2.end();

    if (level2Tiles > 1) {
      // Level 3: scan aux2 in a single workgroup (≤256 entries for 8M splats)
      // aux3 exists solely to honor the scan shader's binding contract
      // (binding 1 = aux_out must be a separate buffer from binding 0 = data).
      const scan3BG = device.createBindGroup({
        layout: pipelines.scan.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: aux2 } },
          { binding: 1, resource: { buffer: aux3 } },
        ],
      });
      const scan3 = encoder.beginComputePass({ label: `${passLabel}-scan-L3` });
      scan3.setPipeline(pipelines.scan);
      scan3.setBindGroup(0, scan3BG);
      scan3.dispatchWorkgroups(1);
      scan3.end();

      // Add back: aux2 → aux
      const addBack2BG = device.createBindGroup({
        layout: pipelines.scanAddBack.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: aux } },
          { binding: 1, resource: { buffer: aux2 } },
        ],
      });
      const addBack2 = encoder.beginComputePass({ label: `${passLabel}-addback-L2` });
      addBack2.setPipeline(pipelines.scanAddBack);
      addBack2.setBindGroup(0, addBack2BG);
      addBack2.dispatchWorkgroups(level2Tiles);
      addBack2.end();
    }

    // Add back: aux → data
    const addBack1BG = device.createBindGroup({
      layout: pipelines.scanAddBack.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: data } },
        { binding: 1, resource: { buffer: aux } },
      ],
    });
    const addBack1 = encoder.beginComputePass({ label: `${passLabel}-addback-L1` });
    addBack1.setPipeline(pipelines.scanAddBack);
    addBack1.setBindGroup(0, addBack1BG);
    addBack1.dispatchWorkgroups(level1Tiles);
    addBack1.end();
  }
}

// ─── Sort Encoding ───────────────────────────────────────────────

/**
 * Encode 8 radix passes (4-bit each) into a command encoder.
 *
 * Each pass: Count → multi-level Scan → Scatter.
 * Ping-pong between indicesA and indicesB.
 * After 8 passes (even), result is in indicesA.
 *
 * @returns buffers.indicesA — the buffer containing final sorted indices
 */
export function encodeSortGlobal(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GlobalSortPipelines,
  buffers: GlobalSortBuffers,
): GPUBuffer {
  const numWorkgroups = Math.ceil(buffers.splatCount / WORKGROUP_SIZE);
  const histogramElements = numWorkgroups * RADIX_BUCKETS;
  const paramsData = new Uint32Array(4);

  let readBuffer = buffers.indicesA;
  let writeBuffer = buffers.indicesB;

  for (let pass = 0; pass < RADIX_PASSES; pass++) {
    const shift = pass * RADIX_BITS;

    // Write params: [count, shift, numWorkgroups, 0]
    paramsData[0] = buffers.splatCount;
    paramsData[1] = shift;
    paramsData[2] = numWorkgroups;
    paramsData[3] = 0;
    device.queue.writeBuffer(buffers.params, 0, paramsData);

    // ─── Pass 1: Count ───────────────────────────────────────
    const countBG = device.createBindGroup({
      layout: pipelines.count.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.sortKeys } },
        { binding: 1, resource: { buffer: readBuffer } },
        { binding: 2, resource: { buffer: buffers.histogram } },
        { binding: 3, resource: { buffer: buffers.params } },
      ],
    });
    const countPass = encoder.beginComputePass({ label: `count-${pass}` });
    countPass.setPipeline(pipelines.count);
    countPass.setBindGroup(0, countBG);
    countPass.dispatchWorkgroups(numWorkgroups);
    countPass.end();

    // ─── Pass 2: Multi-level Scan ────────────────────────────
    encodeMultiLevelScan(
      device, encoder, pipelines,
      buffers.histogram, buffers.scanAux, buffers.scanAux2, buffers.scanAux3,
      histogramElements,
      `pass-${pass}`,
    );

    // ─── Pass 3: Scatter ─────────────────────────────────────
    const scatterBG = device.createBindGroup({
      layout: pipelines.scatter.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.sortKeys } },
        { binding: 1, resource: { buffer: readBuffer } },
        { binding: 2, resource: { buffer: writeBuffer } },
        { binding: 3, resource: { buffer: buffers.histogram } },
        { binding: 4, resource: { buffer: buffers.params } },
      ],
    });
    const scatterPass = encoder.beginComputePass({ label: `scatter-${pass}` });
    scatterPass.setPipeline(pipelines.scatter);
    scatterPass.setBindGroup(0, scatterBG);
    scatterPass.dispatchWorkgroups(numWorkgroups);
    scatterPass.end();

    // Ping-pong
    [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
  }

  return buffers.indicesA;
}
