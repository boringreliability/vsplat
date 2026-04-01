---
ward: 12
revision: 2
name: "Global GPU Radix Sort"
epic: "production-hardening"
status: "red"
dependencies: [6]
layer: "wgsl"
estimated_tests: 10
created: "2026-04-01"
completed: null
---
# Ward 012: Global GPU Radix Sort

## Red-State Description

Ward 6 shipped a "Single-Workgroup Prototype" radix sort that only sorts correctly within 256-element tiles. For 5M splats (~20,000 workgroups), there is zero cross-workgroup coordination. The GPU sort output is incorrect for any dataset exceeding 256 elements. All downstream wards (7-11) currently depend on the CPU reference implementation for correctness. This Ward exists to close that gap.

## Scope

Replace the Single-Workgroup Prototype radix sort (Ward 6) with a globally correct 3-pass radix sort for WebGPU. The implementation must produce correct output for all supported dataset sizes (up to 2^23 = 8M splats) without any tile-local-only code paths remaining in production.

The CPU reference implementation (`radix-sort-cpu.ts`) is the correctness oracle and remains unchanged.

## Inputs

- Ward 6: `radix-sort-cpu.ts` — CPU reference (frozen, correctness oracle)
- Ward 6: `radix-sort-gpu.ts` — prototype buffer layout and `SortBuffers` interface (informational only)
- Ward 6: `floatToSortableUint` — IEEE 754 → sortable uint conversion (shared)
- Ward 7: `splat-shader.ts` — consumes `sorted_indices` buffer (downstream contract)

## Outputs

- `src/webgpu/radix-sort-global.ts` — new file containing:
  - `createGlobalSortBuffers(device, splatCount)` → `GlobalSortBuffers`
  - `createGlobalSortPipelines(device)` → `GlobalSortPipelines` (3 compute pipelines)
  - `encodeSortGlobal(device, encoder, pipelines, buffers)` → `GPUBuffer`
  - `WORKGROUP_SIZE` constant (exported)
- 3 WGSL compute shaders embedded in the above file

## Non-Outputs

- Does NOT modify `radix-sort-cpu.ts` (oracle is frozen)
- Does NOT modify `radix-sort-gpu.ts` (Ward 6 prototype preserved)
- Does NOT add browser integration tests (requires real WebGPU — Ward 17 scope)
- Does NOT swap downstream imports (Ward 16+ scope)

## Specification

### Architecture: 3-Pass Global Radix Sort

Each radix pass (one per 4-bit digit, 8 passes total for 32-bit keys) executes three GPU dispatches:

#### Pass 1: Count (Histogram)

Each workgroup processes a tile of `WORKGROUP_SIZE` elements. For each element, extract the current 4-bit digit (0-15) and atomically increment a workgroup-local counter. After the workgroup barrier, thread 0 writes the 16-bucket histogram to the global histogram buffer.

The histogram buffer uses **column-major layout**: `histogram[digit * numWorkgroups + workgroup_id]`. This places all workgroup contributions for a single digit contiguously in memory, enabling efficient sequential scan in Pass 2.

```
Input:  sort_keys[N], indices_in[N]
Output: histogram[numWorkgroups * 16]
```

#### Pass 2: Scan (Global Exclusive Prefix Sum)

Compute a global exclusive prefix sum over the entire histogram buffer. The scan must be globally correct for all supported dataset sizes.

**Hard requirement:** This Ward MUST implement a scan path that handles `numWorkgroups * 16` elements for up to 8M splats. At WORKGROUP_SIZE=256, 8M splats = 32,768 workgroups. `32,768 * 16 = 524,288` scan elements. A single-workgroup scan (limited to 256 elements) is NOT acceptable as the sole implementation.

**Implementation:** Multi-level scan (Blelloch or equivalent):
1. Each workgroup scans a tile of the histogram (up to WORKGROUP_SIZE elements)
2. The per-workgroup totals are collected into an auxiliary buffer
3. The auxiliary buffer is scanned (recursively if needed, but 524K / 256 = 2048 elements fits in one additional level)
4. The per-workgroup scans are adjusted by adding the scanned auxiliary totals

This produces a globally correct exclusive prefix sum. The auxiliary buffer is allocated once in `createGlobalSortBuffers`.

```
Input:  histogram[numWorkgroups * 16]
Output: prefix_sums[numWorkgroups * 16] (in-place)
Aux:    scan_aux[ceil(numWorkgroups * 16 / WORKGROUP_SIZE)]
```

#### Pass 3: Scatter

Each workgroup re-reads its tile from `indices_in`. For each element, re-extract the 4-bit digit, look up the global prefix sum for `(digit, workgroup_id)`, and use a workgroup-local atomic counter to compute the final destination. Write to `indices_out[destination]`.

```
Input:  sort_keys[N], indices_in[N], prefix_sums[numWorkgroups * 16]
Output: indices_out[N]
```

### Radix Configuration

- **Radix bits:** 4 (16 buckets per pass)
- **Passes:** 8 (4 bits × 8 = 32 bits)
- **Workgroup size:** 256

**GPU-specific design divergence from CPU reference:** The CPU reference uses 8-bit radix (256 buckets, 4 passes). The GPU uses 4-bit radix (16 buckets, 8 passes). This is a deliberate tradeoff: double the passes, but the global scan operates on `numWorkgroups * 16` instead of `numWorkgroups * 256`, reducing scan complexity by 16×. Stability and ordering semantics MUST match the CPU oracle output — the radix width affects performance, not correctness.

### Buffer Layout

```
GlobalSortBuffers {
  sortKeys:    GPUBuffer   // u32[splatCount]
  indicesA:    GPUBuffer   // u32[splatCount] — ping
  indicesB:    GPUBuffer   // u32[splatCount] — pong
  histogram:   GPUBuffer   // u32[numWorkgroups * 16]
  scanAux:     GPUBuffer   // u32[ceil(numWorkgroups * 16 / WORKGROUP_SIZE)]
  params:      GPUBuffer   // uniform: { count: u32, shift: u32, numWorkgroups: u32, _pad: u32 }
  splatCount:  number
}
```

Params uniform: 16 bytes (3 × u32 + 4 bytes padding for alignment).

### Ping-Pong Contract

After 8 passes (even number), the final sorted result is in `indicesA`. This invariant MUST hold regardless of radix configuration. It matches Ward 6's existing contract.

### Error Handling

- `createGlobalSortBuffers` throws `RangeError` if `splatCount <= 0` or non-integer
- `createGlobalSortPipelines` throws if any of the 3 shader compilations fail
- Error messages include the WGSL compilation error text

## Tests

Tests are in `tests/ward-012/global-sort.test.ts`.

Tests are divided into two categories with distinct verification claims:

### Category A: Oracle Contract Tests

These verify that the CPU reference implementation (Ward 6) produces correct results. They do NOT verify Ward 12's GPU implementation. They exist in this file because Ward 12 depends on the oracle being correct, and regressions in the oracle would produce false passes in orchestration tests.

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `cpu_oracle_100k_correctness` | CPU `radixSortIndices` produces correct descending order for 100K random elements. Every index appears exactly once (permutation). |
| A2 | `cpu_oracle_negative_depths` | CPU sort handles mixed positive/negative floats. `floatToSortableUint` sign-bit handling across full range. |
| A3 | `cpu_oracle_stability` | 1000 equal-key elements preserve original index order across workgroup-size boundaries. |
| A4 | `cpu_oracle_1m_performance` | CPU reference sorts 1M elements in under 200ms. Regression guard, not GPU performance claim. |

### Category B: Ward 12 Orchestration Tests

These verify that the TypeScript orchestration layer in `radix-sort-global.ts` creates correct buffers, dispatches correct passes, and wires correct bind groups. They prove architecture and contracts, not GPU-side numerical correctness.

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `histogram_buffer_sizing` | `createGlobalSortBuffers` allocates histogram as `ceil(splatCount / WORKGROUP_SIZE) * 16 * 4` bytes. `scanAux` buffer exists and is correctly sized. Index buffers are double-buffered. |
| B2 | `three_pass_dispatch_count` | `encodeSortGlobal` dispatches exactly 3 compute passes per radix pass. 8 passes × 3 dispatches = 24 total `beginComputePass` calls. Multi-level scan dispatches additional passes as needed (counted separately). |
| B3 | `params_uniform_contents` | `writeBuffer` for params writes `[count, shift, numWorkgroups, 0]` (4 × u32 = 16 bytes). Third value equals `ceil(splatCount / WORKGROUP_SIZE)`. |
| B4 | `histogram_bind_group_wiring` | All three passes (count, scan, scatter) reference the histogram buffer in their bind groups. Scatter reads from the same histogram that scan wrote to. |
| B5 | `scan_aux_buffer_wiring` | The scan pass bind group includes the auxiliary buffer. The second-level scan (if dispatched) reads from and writes to the auxiliary buffer. |
| B6 | `ping_pong_final_in_indicesA` | After `encodeSortGlobal` completes, the returned buffer is `buffers.indicesA`. Verified for both even and odd pass-count scenarios (currently 8 = even). |

### What These Tests Do NOT Prove

- GPU-side numerical correctness (requires real WebGPU device — Ward 17)
- Real GPU performance (requires hardware benchmarks — Ward 17)
- WGSL shader correctness beyond structural compilation (race conditions, barrier bugs, atomics ordering are invisible to Node mocks)
- Integration with render pipeline (Ward 16+ scope)

## Must NOT

- Modify `radix-sort-cpu.ts` — oracle is frozen
- Leave any tile-local-only sort path reachable in production
- Use comparison-based sort (must remain O(n))
- Allocate new buffers per frame or per pass
- Ship a scan that silently produces wrong results for datasets above one workgroup
- Ship a single-workgroup-only scan as the production path
- Claim GPU correctness based on Node mock tests alone

## Must DO

- Implement 3 WGSL compute shaders: Count, Scan, Scatter
- Implement multi-level scan that handles `numWorkgroups * 16` up to 524,288 elements
- Allocate `scanAux` buffer for multi-level prefix sum
- Use 4-bit radix (16 buckets) — document this as a GPU-specific divergence from CPU reference
- Use column-major histogram layout for contiguous scan access
- Export `WORKGROUP_SIZE` for test assertions
- Ping-pong `indicesA`/`indicesB`; final result in `indicesA`
- Params uniform: `{ count: u32, shift: u32, numWorkgroups: u32, _pad: u32 }` = 16 bytes
- All dataset size thresholds are explicit and enforced (not silent)
- Fallback behavior (if any) is explicit, tested, and documented — not silent degradation

## Verification

### Green Criteria

1. All 10 tests pass (4 oracle + 6 orchestration)
2. `src/webgpu/radix-sort-global.ts` exists with all exported symbols
3. Three WGSL shaders contain `@compute` + `@workgroup_size`
4. Histogram buffer sized to `ceil(splatCount / WORKGROUP_SIZE) * 16 * 4` bytes
5. `scanAux` buffer exists and is sized for multi-level scan
6. `encodeSortGlobal` dispatches at least 24 compute passes (8 × 3, plus scan sub-passes)
7. Scan path handles `numWorkgroups * 16` up to 524,288 elements without silent failure
8. No code path exists where tile-local-only sorting is reachable for supported dataset sizes

### Deferred Verification (not blocked, explicitly out of scope)

- GPU numerical correctness vs CPU oracle on real WebGPU device (Ward 17)
- Production GPU performance on target hardware (Ward 17)
- Render pipeline integration under real scene load (Ward 16+)
- WGSL race condition / barrier / atomics correctness (Ward 17 browser tests)

## Relationship to Other Wards

### Ward 6 (upstream, preserved)
`radix-sort-gpu.ts` and `radix-sort-cpu.ts` are unchanged. Ward 12 is a new file alongside them, not a replacement within them.

### Ward 7 (downstream consumer)
`splat-shader.ts` reads `sorted_indices` from a storage buffer. Ward 12's output buffer (`indicesA`) must be bindable as `var<storage, read>` with the same element type (`array<u32>`). This is a layout contract, not an integration — the actual import swap happens in Ward 16+.

### Ward 17 (deferred verification)
Browser integration tests that compare GPU-sorted output against CPU oracle output on real WebGPU devices. This is where WGSL correctness (race conditions, atomics, barriers) is actually proven.
