---
ward: 16
revision: null
name: "True Streaming I/O"
epic: "production-hardening"
status: "planned"
dependencies: [3, 11]
layer: "typescript"
estimated_tests: 7
created: "2026-04-01"
completed: null
---
# Ward 016: True Streaming I/O

## Scope
Make import AND export genuinely memory-bounded. The current import (Ward 3) reads chunked but materializes full SoA arrays. The current export (Ward 11) claims streaming but has been improved to batch — verify and harden both directions. Define explicit memory budgets and failure behavior for partial writes, cancel, and EOF.

## Inputs
- Ward 3: PLY parser (chunked binary streaming)
- Ward 11: Export engine (batched streaming)
- Ward 2: OPFS pipeline

## Outputs
- Memory-bounded import pipeline with explicit budget
- Verified export streaming (no full materialization)
- Partial write recovery / cancel semantics for export
- EOF handling for truncated imports
- Memory budget acceptance criteria (peak RAM < 1.5× final data)

## Specification
1. **Import memory audit:** Verify that PLY import peak memory is bounded. Document where large allocations happen (SoA pre-allocation is expected; extra copies are not).

2. **Export memory verification:** Prove that exportChunked never holds more than one batch in RAM (batch buffer is reused, not accumulated).

3. **Truncated import handling:** If PLY file is truncated mid-stream, parser must return a clear error (not crash or produce partial corrupt data).

4. **Export cancellation:** If export is cancelled mid-stream (sink throws or cancel signal), cleanup must happen (no orphaned OPFS files).

5. **Memory budget:** Define and test that import of N splats uses < 1.5× N × stride bytes peak RAM.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | import_truncated_file_errors | Truncated PLY returns error, not corrupt data |
| 2 | export_batch_buffer_reused | Export uses one batch buffer, not accumulating |
| 3 | export_cancel_cleans_up | Cancelled export calls sink.close() |
| 4 | import_exact_allocation | Import pre-allocates once, no extra copies |
| 5 | export_empty_file_valid | 0-splat export produces valid PLY |
| 6 | roundtrip_large_dataset | 50K splat roundtrip: import→delete 10K→export→reimport = 40K |
| 7 | memory_budget_acceptance | Peak memory < 1.5× final data size |

## Must NOT
- Materialize full file in RAM during export
- Produce corrupt data on truncated input
- Leave orphaned OPFS files on export failure
- Exceed memory budget silently

## Must DO
- Verify memory-bounded behavior for both import and export
- Handle truncated/corrupt PLY gracefully
- Support export cancellation with cleanup
- Define explicit memory budget and test it

## Verification
- All 7 tests green
- Truncated files produce clear errors
- Export cancellation does not leak resources
- Memory budget documented and enforced
