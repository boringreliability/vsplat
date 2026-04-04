---
ward: 17
revision: 2
name: "Runtime Resilience & Fallbacks"
epic: "production-hardening"
status: "complete"
dependencies: [1, 5, 15]
layer: "typescript"
estimated_tests: 9
created: "2026-04-01"
completed: "2026-04-04"
---
# Ward 017: Runtime Resilience & Fallbacks

## Problem Statement

vsplat depends on four browser capabilities that are not universally available: WebGPU, OPFS, Web Workers, and cross-origin isolation (for SharedArrayBuffer). When any of these is missing, the application currently fails silently — no error message, no fallback, just a blank screen or a cryptic console error.

Beyond capability detection, production browsers introduce runtime failures that the application must survive: GPU shader compilation errors, Worker crashes mid-operation, out-of-memory during scene load, and bridge operations that hang indefinitely because a Worker stops responding.

Ward 17 makes vsplat resilient to all detectable failure modes with structured error types and user-actionable messages.

## Scope

Define a structured error type system (`VsplatError`). Implement a capability gate that checks all required features before initialization. Add timeout protection to all bridge operations (not just init). Surface GPU compilation failures, Worker crashes, and memory pressure as actionable errors. No new rendering features — this Ward is about surviving the hostile browser environment.

## Inputs

- Ward 1: Feature detection — `detectWebGPU()`, `detectOPFS()`, `detectWorker()`, `detectCrossOriginIsolation()`
- Ward 5: WebGPU pipeline setup — `createRenderPipeline`, shader compilation
- Ward 7: Splat shader — `compilationInfo()` error handling
- Ward 15: Worker bridge — `createWorkerBridge`, `loadPly`, `getBuffers`, `terminate`

## Outputs

### Error Types (`src/errors/vsplat-error.ts`)
```typescript
type VsplatErrorCode =
  | "UNSUPPORTED_WEBGPU"
  | "UNSUPPORTED_OPFS"
  | "UNSUPPORTED_WORKER"
  | "UNSUPPORTED_CROSS_ORIGIN"
  | "GPU_COMPILATION_FAILED"
  | "SCENE_TOO_LARGE"
  | "WORKER_CRASHED"
  | "BRIDGE_TIMEOUT"
  | "LOAD_FAILED";

interface VsplatError {
  code: VsplatErrorCode;
  message: string;        // user-facing, actionable
  details?: string;       // technical details (shader name, error log, etc.)
  recoverable: boolean;   // can the user retry or must they change browser?
}
```

### Capability Gate (`src/errors/capability-gate.ts`)
```typescript
interface CapabilityCheck {
  error: VsplatError | null;    // first blocking failure, or null if all OK
  warnings: VsplatError[];      // non-blocking issues (e.g. missing cross-origin isolation)
}

function checkCapabilities(): CapabilityCheck;
```
Returns `{ error: null, warnings: [] }` if all capabilities are present. Returns the first missing hard requirement as `error`. Cross-origin isolation is a soft check — missing isolation produces a warning in the `warnings` array, not a blocking error.

### Bridge Timeout Protection (update `src/worker/bridge.ts`)
All bridge operations (`loadPly`, `getBuffers`, `ping`) get configurable timeouts. Default: 30s for `loadPly` (large files), 10s for `getBuffers` and `ping`. Timeout produces a `VsplatError` with code `BRIDGE_TIMEOUT`.

**Late reply semantics:** When a timeout fires, the pending entry is removed from the FIFO queue and the promise is rejected. If the Worker responds after the timeout, the late reply finds no matching entry in the queue and is silently dropped. This is safe because the FIFO protocol guarantees message ordering — a late reply can only match the already-rejected request. No request IDs needed.

### GPU Compilation Error Surface (update shader pipeline)
When `compilationInfo()` returns errors, wrap them in `VsplatError` with code `GPU_COMPILATION_FAILED`, including shader name and compilation message in `details`.

### Memory Pressure Estimation
Before loading a scene, estimate memory requirement from splat count and SH dimension:
```typescript
const inputBytes = splatCount * 236;                          // conservative PLY stride (full SH3)
const cpuBytes = splatCount * (3 + 4 + 3 + 1 + shDim) * 4;  // SplatData arrays
const gpuBytes = cpuBytes;                                     // GPU buffers (writeBuffer copy)
const estimatedBytes = Math.ceil((inputBytes + cpuBytes + gpuBytes) * 1.5);  // 1.5× safety margin
```
If `estimatedBytes > threshold` (configurable, default 2GB), return `VsplatError` with code `SCENE_TOO_LARGE`. This is the single source of truth for memory estimation — used by both `estimateSceneMemory()` and `checkSceneMemory()`.

## Non-Outputs

- Does NOT implement WebGL fallback rendering (WebGPU is a hard requirement)
- Does NOT implement offline/ServiceWorker caching
- Does NOT implement UI components for error display (that's application layer)
- Does NOT run real browser integration tests (deferred to manual verification)
- Does NOT verify fragment shader pixel-space correctness (requires real GPU — see Deferred Verification)

## Specification

### 1. VsplatError Type System

All error paths in vsplat should produce `VsplatError` objects, not raw `Error` or strings. Each variant has:
- `code`: machine-readable, switchable
- `message`: human-readable, tells the user what to do ("Your browser does not support WebGPU. Try Chrome 113+ or Edge 113+.")
- `details`: optional technical details for debugging
- `recoverable`: `true` if retry might help (Worker crash, bridge timeout), `false` if the user needs a different browser (missing WebGPU)

### 2. Capability Gate

`checkCapabilities()` checks in order:
1. WebGPU (`navigator.gpu` exists) — **blocking**
2. Web Workers (`typeof Worker !== 'undefined'`) — **blocking**
3. OPFS (`navigator.storage?.getDirectory` exists) — **blocking**
4. Cross-origin isolation (`crossOriginIsolated`) — **warning only**

Returns `{ error, warnings }`. `error` is the FIRST missing hard requirement. `warnings` contains non-blocking issues. Cross-origin isolation is a warning because the base application works without SharedArrayBuffer — it's only needed for the zero-copy Worker↔Main optimization path.

### 3. Bridge Operation Timeouts

Update `bridge.ts` to add timeout to all operations:

```typescript
interface BridgeTimeouts {
  init: number;      // default 10_000ms (existing)
  loadPly: number;   // default 30_000ms (large files)
  getBuffers: number; // default 10_000ms
  ping: number;       // default 5_000ms
}
```

When a timeout fires:
- Reject the pending promise with `VsplatError { code: "BRIDGE_TIMEOUT", ... }`
- Do NOT terminate the Worker (it might still be working — let the caller decide)
- Include the operation name and elapsed time in the error message

### 4. GPU Compilation Error Handling

When `device.createShaderModule()` + `compilationInfo()` reports errors:
- Wrap in `VsplatError { code: "GPU_COMPILATION_FAILED", details: compilationMessages }`
- Include which shader failed (vertex/fragment/compute, module name)
- `recoverable: false` (shader bugs are code bugs, not user-fixable)

**Testing limitation:** Mock `compilationInfo()` cannot validate real WGSL syntax. The test verifies that IF `compilationInfo()` returns errors, they are correctly wrapped in `VsplatError`. Real shader validation requires a GPU device and is deferred to manual browser testing.

### 5. Memory Pressure Estimation

`estimateSceneMemory(splatCount: number, shDim: number): number` returns estimated bytes using the consolidated formula from Outputs section (inputBytes + cpuBytes + gpuBytes × 1.5 safety margin).

`checkSceneMemory(splatCount: number, shDim: number, threshold?: number): VsplatError | null` returns a `VsplatError` with code `SCENE_TOO_LARGE` if `estimateSceneMemory()` exceeds threshold (default 2GB).

### 6. Worker Crash Recovery

When `worker.onerror` fires:
- Wrap in `VsplatError { code: "WORKER_CRASHED", recoverable: true }`
- Reject ALL pending promises in the bridge queue
- Set `bridge.ready = false`
- The caller can create a new bridge to retry

## Tests

### Category A: Error Types & Capability Gate

| # | Test Name | Verifies |
|---|-----------|----------|
| A1 | `capability_gate_all_present` | All features detected → `checkCapabilities()` returns `{ error: null, warnings: [] }` |
| A2 | `capability_gate_no_webgpu` | Missing `navigator.gpu` → `error` is `VsplatError` with code `UNSUPPORTED_WEBGPU` and actionable message mentioning Chrome/Edge |
| A3 | `capability_gate_no_opfs` | Missing `navigator.storage.getDirectory` → `error` is `VsplatError` with code `UNSUPPORTED_OPFS` |
| A4 | `error_types_actionable` | Every `VsplatErrorCode` variant has a non-empty `message` and correct `recoverable` flag |

### Category B: Bridge Resilience

| # | Test Name | Verifies |
|---|-----------|----------|
| B1 | `bridge_load_timeout` | `loadPly` with non-responding Worker → rejects with `BRIDGE_TIMEOUT` after configured timeout, includes operation name |
| B2 | `worker_crash_rejects_pending` | Worker `onerror` fires → all pending promises rejected with `WORKER_CRASHED`, `bridge.ready` is false |

### Category C: GPU & Memory

| # | Test Name | Verifies |
|---|-----------|----------|
| C1 | `gpu_compilation_failure_surfaced` | Mock `compilationInfo()` returns errors → `VsplatError` with code `GPU_COMPILATION_FAILED`, `details` includes shader name and error text |
| C2 | `memory_pressure_warning` | `checkSceneMemory(10_000_000, 48)` with 2GB threshold → returns `VsplatError` with code `SCENE_TOO_LARGE`. `checkSceneMemory(100_000, 3)` → returns `null` |
| C3 | `memory_estimate_accuracy` | `estimateSceneMemory(1_000_000, 48)` returns value within expected range (accounting for all buffer copies + safety margin) |

## Must NOT

- Show blank screen on any detectable failure
- Swallow errors into `console.log` only (every error must produce a `VsplatError`)
- Assume all browsers have all features
- Terminate the Worker on bridge timeout (let the caller decide)
- Block on missing cross-origin isolation (soft warning only)
- Claim to validate WGSL syntax in unit tests (mock limitation)

## Must DO

- Define `VsplatError` type with code, message, details, recoverable
- Check all capabilities before init
- Add timeout to ALL bridge operations (loadPly, getBuffers, ping)
- Surface GPU compilation errors as structured `VsplatError`
- Estimate scene memory before loading
- Handle Worker crashes by rejecting all pending promises
- Make every error message actionable ("do X to fix this")

## Verification

### Green Criteria

1. All 9 tests pass
2. Every `VsplatErrorCode` variant has an associated message and recoverable flag
3. `checkCapabilities()` returns specific errors for missing features
4. Bridge operations have configurable timeouts
5. GPU compilation errors are wrapped in `VsplatError`
6. Memory estimation produces reasonable values
7. Worker crashes don't leave the bridge in an inconsistent state

### Deferred Verification

- **Fragment shader pixel-space correctness:** `@builtin(position).xy - center` in the splat fragment shader is mathematically correct (WGSL `@builtin(position)` is screen-space in fragment stage), but has not been verified with a real GPU. First browser test should visually confirm splat rendering. This is NOT a Ward 17 test — it requires a real GPU device.
- **Real browser capability detection:** Unit tests mock `navigator.gpu` etc. Real detection requires running in actual browsers with and without these features.
- **OOM recovery during actual load:** `checkSceneMemory` estimates before load. Actual OOM during `batch_spawn_splats` or GPU upload is harder to catch and is deferred to browser testing.
- **COOP/COEP header verification:** Cross-origin isolation depends on server headers, not application code. Documented but not testable in unit tests.

## Relationship to Other Wards

### Ward 1 (upstream, consumed)
Feature detection functions are called by `checkCapabilities()`. Ward 1's API is not modified.

### Ward 5 (upstream, extended)
GPU pipeline setup is wrapped with `VsplatError` error handling for compilation failures. Ward 5's core rendering code is not modified — error wrapping happens at the call site.

### Ward 15 (upstream, extended)
Bridge operations get timeout wrappers. The bridge's existing error propagation (`type: "error"` messages) is preserved. Timeouts are an additional failure mode on top of the existing protocol.

### Ward 7 (upstream, verified)
The splat shader's `compilationInfo()` path is wrapped in `VsplatError`. The shader itself is not modified. Fragment shader pixel-space correctness is noted as deferred verification.