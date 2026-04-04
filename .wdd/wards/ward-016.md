---
ward: 16
revision: 1
name: "True Streaming I/O"
epic: "production-hardening"
status: "complete"
dependencies: [3, 11, 15]
layer: "typescript+rust"
estimated_tests: 7
created: "2026-04-01"
completed: "2026-04-04"
---
# Ward 016: True Streaming I/O

## Problem Statement

The import and export paths claim to be streaming but have not been verified for memory-bounded behavior at production scale.

**Import (Ward 3):** The PLY parser reads binary data in chunks (`parse_chunked`), but the output is a fully materialized `SplatData` struct with pre-allocated `Vec<f32>` arrays. This is intentional (GPU upload requires contiguous buffers), but there may be hidden intermediate copies or double-allocations that blow the memory budget. Truncated files are handled by the parser's strict byte-count validation, but this has not been tested with realistic truncation scenarios.

**Export (Ward 11):** The export engine claims batched streaming via `exportChunked`, but it has not been verified that the batch buffer is reused (not accumulated). A cancelled export could leave orphaned OPFS files.

**Ward 15 bridge:** `bridge.loadPly()` transfers the PLY `ArrayBuffer` to the Worker. After transfer, the main thread's copy is neutered (zero bytes). But the Worker holds both the input bytes AND the parsed `SplatData` simultaneously during parsing. This is the actual peak memory moment.

## Scope

Verify and harden both import and export for memory-bounded, cancellation-safe, error-resilient behavior. Define explicit memory scaling criteria. No new features — this Ward is about proving what exists works correctly at scale.

## Inputs

- Ward 3: `PlyParser` — `parse_all`, `parse_chunked`, `SplatData::with_capacity`
- Ward 11: Export engine — `exportChunked`, PLY writer, download utility
- Ward 15: `bridge.loadPly()` — ArrayBuffer transfer to Worker

## Outputs

- Verified memory-bounded import (no hidden copies beyond SoA pre-allocation)
- Verified export streaming (batch buffer reused, not accumulated)
- Truncated import error handling tested
- Export cancellation with cleanup tested
- Memory scaling criteria defined and tested (linear, not quadratic)

## Non-Outputs

- Does NOT change the PLY parser architecture (chunked → full SoA is intentional)
- Does NOT add incremental/progressive rendering (load all, then render)
- Does NOT implement partial scene loading (load first N splats)
- Does NOT change the export format

## Specification

### 1. Import Memory Audit

The import path has two legitimate large allocations:
1. Input bytes (`&[u8]` / `ArrayBuffer`) — size = vertex_count × stride
2. Output `SplatData` — size = vertex_count × (3+4+3+1+sh_dim) × 4 bytes

Both exist simultaneously during parsing. After parsing completes, input bytes can be freed. `batch_spawn_splats` does one more `extend_from_slice` per buffer into `World`'s flat arrays — but these reuse the same data, not copy it (Rust moves ownership where possible, copies where `SplatData` is borrowed).

**What must NOT happen:** Extra intermediate copies during parsing. `SplatData::with_capacity` pre-allocates once; `extract_vertex` pushes into pre-allocated Vecs. No temporary `Vec` that is later copied into the final output.

### 2. Export Memory Verification

`exportChunked` must process splats in batches. Each batch writes to the sink and then the batch buffer is reused for the next batch. The export function must NOT accumulate all batches in memory before writing.

**Verification strategy:** Mock the sink to track how many times `write()` is called and verify that total bytes written equals expected file size, but peak buffer size never exceeds one batch.

### 3. Truncated Import Handling

If a PLY file is truncated (binary section shorter than header declares), the parser must:
- Return a clear `Err` with a message indicating the truncation
- NOT produce partial/corrupt `SplatData`
- NOT panic or crash

Ward 3's `parse_all` already checks `binary_data.len() != expected`, but `parse_chunked` has a separate code path that must also be verified.

### 4. Export Cancellation

If the export sink throws an error or a cancel signal is received mid-export:
- The export function must propagate the error (not swallow it)
- Any partially written OPFS file must be cleaned up (deleted or closed)
- The World must remain in a consistent state (export is read-only)

### 5. Memory Scaling Criteria

Memory usage must scale linearly with splat count. Specifically:

- Load N splats → measure memory M₁
- Load 10×N splats → measure memory M₂
- Ratio M₂/M₁ must be < 12 (allows 20% overhead margin over perfect 10×)
- Ratio M₂/M₁ must be > 5 (sanity check: not suspiciously low due to GC)

This tests the scaling property, not the absolute value. It catches hidden quadratic behavior (extra copies, accumulating buffers) without being flaky due to GC timing or platform differences.

## Tests

### Category A: Import Hardening

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `import_truncated_file_errors` | PLY truncated at 50% of declared binary size → `Err` with clear message. No partial data returned. Both `parse_all` and `parse_chunked` paths tested. |
| A2 | `import_exact_allocation` | After `parse_all(100K splats)`, `SplatData` Vec capacities equal or barely exceed their lengths (no 2× over-allocation). Ratio `capacity / length < 1.1` for all buffers. |
| A3 | `memory_scales_linearly` | Load 10K splats → measure heapUsed. Load 100K splats → measure heapUsed. Ratio is between 5× and 12×. |

### Category B: Export Hardening

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `export_batch_buffer_reused` | Mock sink counts `write()` calls. For 50K splats with batch size 10K: exactly 5 write calls + 1 header write. Total bytes = expected PLY size. |
| B2 | `export_cancel_cleans_up` | Sink throws on 3rd write call. Export function propagates the error. No orphaned partial data. |
| B3 | `export_empty_file_valid` | 0-splat export produces valid PLY with correct header and zero-length binary section. Re-import of the file succeeds with count=0. |

### Category C: Roundtrip

| # | Test Name | Verifies |
|---|-----------|----------|
| C1 | `roundtrip_large_dataset` | Import 50K splats → soft-delete 10K → export (should contain 40K) → re-import → verify 40K splats with correct positions and SH data. |

## Must NOT

- Materialize full file in RAM during export (batch-only)
- Produce corrupt or partial `SplatData` on truncated input
- Leave orphaned OPFS files on export failure
- Swallow export sink errors silently
- Exceed linear memory scaling (ratio > 12× for 10× data)
- Modify the PLY parser's core architecture

## Must DO

- Verify both `parse_all` and `parse_chunked` handle truncation
- Verify export batch buffer is reused, not accumulated
- Verify export cancellation propagates errors and cleans up
- Test memory scaling with relative measurement (not absolute)
- Test full roundtrip with deletion and re-import
- Test empty export edge case

## Verification

### Green Criteria

1. All 7 tests pass (3 import + 3 export + 1 roundtrip)
2. Truncated import returns `Err`, not corrupt data
3. Export cancellation propagates error, no resource leaks
4. Memory ratio between 10K and 100K loads is < 12×
5. Roundtrip preserves data integrity through delete + export + reimport
6. Ward 3 and Ward 11 existing tests still pass (no regressions)

### Deferred Verification

- Real OPFS cleanup on export cancellation (browser-only, Ward 17 scope)
- Memory profiling with Chrome DevTools (manual verification, not automated)
- Progressive loading / partial scene rendering (future feature, not this Ward)

## Relationship to Other Wards

### Ward 3 (upstream, verified)
PLY parser is audited but not modified. Both `parse_all` and `parse_chunked` truncation paths are tested.

### Ward 11 (upstream, verified)
Export engine is audited but not modified. Batch buffer reuse and cancellation are tested.

### Ward 15 (upstream, context)
The Worker bridge transfers ArrayBuffer to Worker. Peak memory during load is input bytes + parsed SplatData. This Ward verifies that no additional copies exist beyond those two.

### Ward 17 (downstream)
Browser integration tests will verify OPFS cleanup and real memory profiling. This Ward provides the unit-test foundation.s