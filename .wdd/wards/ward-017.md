---
ward: 17
revision: null
name: "Runtime Resilience & Fallbacks"
epic: "production-hardening"
status: "planned"
dependencies: [1, 5, 15]
layer: "typescript"
estimated_tests: 7
created: "2026-04-01"
completed: null
---
# Ward 017: Runtime Resilience & Fallbacks

## Scope
Handle the hostile reality of production browsers. When WebGPU is missing, OPFS is unavailable, workers fail to init, scenes exceed available memory, or GPU shader compilation fails — the application must degrade gracefully with actionable user-facing messages, not silent black screens or cryptic console errors.

## Inputs
- Ward 1: Feature detection (detectWebGPU, detectOPFS, etc.)
- Ward 5: WebGPU pipeline setup
- Ward 15: Worker runtime

## Outputs
- Capability gate: check all required features before init
- Fallback UI for missing features (actionable messages, not blank)
- Memory pressure detection and scene-too-large warnings
- GPU compilation failure recovery path
- Structured error types with user-actionable messages

## Specification
1. **Capability Gate:** Before any init, check WebGPU + OPFS + Worker + CrossOriginIsolation. If any missing → show specific message.

2. **GPU Compilation Failure:** If shader compilation fails at runtime → surface error with shader name and compilation message. Don't crash the app.

3. **Memory Pressure:** Estimate scene memory before loading. If > threshold → warn user. If OOM during load → catch and surface.

4. **Worker Failure Recovery:** If worker crashes mid-operation → detect via onerror, surface structured error, allow retry.

5. **Error Types:** Define VsplatError enum: UnsupportedBrowser, GpuCompilationFailed, SceneTooLarge, WorkerCrashed, OpfsUnavailable, etc.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | capability_gate_all_present | All features present → init succeeds |
| 2 | capability_gate_no_webgpu | Missing WebGPU → specific error message |
| 3 | capability_gate_no_opfs | Missing OPFS → specific error message |
| 4 | gpu_compilation_failure_surfaced | Shader error → VsplatError with details |
| 5 | memory_pressure_warning | Scene estimate > threshold → warning fired |
| 6 | worker_crash_recovery | Worker onerror → structured error, app not crashed |
| 7 | error_types_actionable | All VsplatError variants have user-facing message |

## Must NOT
- Show blank screen on any detectable failure
- Swallow errors into console.log only
- Assume all browsers have all features

## Must DO
- Check all capabilities before init
- Surface actionable messages for every failure mode
- Define structured error types
- Handle GPU, Worker, and memory failures gracefully

## Verification
- All 7 tests green
- Every failure mode produces a user-readable message
- No silent black screens in any tested failure scenario
