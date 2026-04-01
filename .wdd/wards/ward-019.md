---
ward: 19
revision: null
name: "Observability & Failure Forensics"
epic: "production-hardening"
status: "planned"
dependencies: [17]
layer: "typescript"
estimated_tests: 6
created: "2026-04-01"
completed: null
---
# Ward 019: Observability & Failure Forensics

## Scope
You can't fix what you can't see. Add structured timing, error tracking, and diagnostic reporting so production issues are diagnosable without access to the user's machine. Every critical pipeline stage gets a timing mark. Every failure gets a structured log entry. The result is a diagnostic report that can be copy-pasted into a bug report.

## Inputs
- Ward 17: VsplatError types, capability gate
- All pipeline wards: timing points

## Outputs
- Performance timeline: load, parse, upload, sort, render, export
- Structured error log with timestamps and context
- Diagnostic report generator (JSON snapshot)
- GPU timing queries (if available)
- Console-friendly formatted output for development

## Specification
1. **Performance Timeline:** Record stage timings as `{ stage, startMs, endMs }[]`.
2. **Error Log:** Ring buffer (max 100) of VsplatError with timestamp and context.
3. **Diagnostic Report:** JSON object: browser info, features, timeline, errors, scene stats.
4. **GPU Timing:** Use timestamp-query if available, CPU fallback otherwise.
5. **Dev Output:** Formatted console output in dev mode. Errors only in production.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | timeline_records_stages | Performance marks recorded with start/end |
| 2 | error_log_appends | Errors logged with timestamp and type |
| 3 | error_log_ring_buffer | Log doesn't exceed max entries |
| 4 | diagnostic_report_complete | Report includes features, timeline, errors, scene stats |
| 5 | diagnostic_report_serializable | Report is JSON.stringify-able |
| 6 | gpu_timing_fallback | Falls back to CPU timing when GPU timestamps unavailable |

## Must NOT
- Log sensitive data in diagnostic reports
- Use console.log as the only observability mechanism
- Block the render loop with timing overhead
- Exceed ring buffer limit

## Must DO
- Record timing for every critical pipeline stage
- Structure errors with type, timestamp, and context
- Provide diagnostic report generator
- Fall back gracefully when GPU timing unavailable
- Keep timing overhead under 0.1ms per frame

## Verification
- All 6 tests green
- Diagnostic report is JSON-serializable
- Error log respects ring buffer limit
- Timeline captures all critical stages
