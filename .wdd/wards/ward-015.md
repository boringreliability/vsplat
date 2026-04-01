---
ward: 15
revision: null
name: "Production Worker Runtime"
epic: "production-hardening"
status: "planned"
dependencies: [1, 2]
layer: "typescript"
estimated_tests: 6
created: "2026-04-01"
completed: null
---
# Ward 015: Production Worker Runtime

## Scope
Replace the placeholder createWorker() with a real Worker + Wasm bootstrap. Implement init handshake, structured message protocol with sequence IDs, timeout/error states, cancellation semantics, and cleanup guarantees. The current worker bridge (Ward 1) is a message-passing skeleton — this ward makes it production-survivable.

## Inputs
- Ward 1: worker bridge (FIFO message queue, typed messages)
- Ward 2: OPFS pipeline (SyncAccessHandle in worker)

## Outputs
- Real Worker instantiation with Wasm streaming compilation
- Init handshake protocol (worker ready → main acknowledged)
- Timeout detection for init and message round-trips
- Cancellation: ability to abort in-progress operations
- Termination: clean worker.terminate() with resource cleanup
- Error surfacing: structured error messages from worker to main

## Specification
1. **Worker Bootstrap:** `new Worker(url)` with `compileStreaming` for Wasm module. Worker posts `{ type: "ready" }` when init completes. Main waits with timeout.

2. **Init Handshake:** Main sends `{ type: "init", wasmUrl }`. Worker loads Wasm, initializes memory, posts `{ type: "ready" }`. If no "ready" within timeout → reject with descriptive error.

3. **Message Protocol:** Each message gets a monotonic `seq` ID. Responses reference the request `seq`. Enables correlation without blocking (maintains FIFO for simplicity but adds traceability).

4. **Timeout/Error:** Configurable timeout per operation. Worker errors are caught via `onerror` and surfaced as structured messages to main.

5. **Cancellation:** Main can send `{ type: "cancel", seq }`. Worker checks cancellation flag between chunks. Not instant, but cooperative.

6. **Termination:** `worker.terminate()` plus cleanup of pending promises. No dangling callbacks.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | worker_init_handshake | Worker posts "ready", main resolves init promise |
| 2 | worker_init_timeout | No "ready" within timeout → rejects with error |
| 3 | message_seq_correlation | Response seq matches request seq |
| 4 | worker_error_surfaced | Worker onerror surfaces structured error to main |
| 5 | worker_cancellation | Cancel message stops in-progress operation |
| 6 | worker_terminate_cleanup | terminate() cleans up pending promises |

## Must NOT
- Use postMessage without sequence IDs in production
- Swallow worker errors silently
- Leave dangling promises after terminate
- Assume worker init always succeeds

## Must DO
- Implement real Worker + Wasm bootstrap
- Add init handshake with timeout
- Surface all worker errors as structured messages
- Support cooperative cancellation
- Clean up on termination

## Verification
- All 6 tests green
- Worker init failure produces a clear, actionable error message
- No dangling promises or callbacks after terminate
- Message correlation works across concurrent operations
