---
ward: 18
revision: null
name: "vsplat.io Deployment Hardening"
epic: "production-hardening"
status: "planned"
dependencies: [15, 17]
layer: "typescript"
estimated_tests: 6
created: "2026-04-01"
completed: null
---
# Ward 018: vsplat.io Deployment Hardening

## Scope
Make vsplat.io actually deployable. SharedArrayBuffer requires COOP/COEP headers. Wasm must be served with correct MIME types. Workers must load from correct paths. CSP must allow WebGPU and Wasm without security holes. Asset caching must not serve stale Wasm after deploys.

## Inputs
- Ward 1: COOP/COEP detection
- Ward 15: Worker + Wasm bootstrap
- Ward 17: Capability gate

## Outputs
- Server header configuration (COOP, COEP, CSP)
- Wasm MIME type verification
- Worker/Wasm path resolution under deployment
- Cache-busting strategy for Wasm/JS assets
- Cross-origin isolation verification at runtime
- Deployment checklist document

## Specification
1. **Headers:** COOP: same-origin, COEP: require-corp. Without these, SharedArrayBuffer is unavailable.
2. **CSP:** Allow wasm-unsafe-eval, worker-src 'self'. No unsafe-inline or wildcard origins.
3. **Wasm MIME:** Server must serve .wasm as application/wasm.
4. **Asset Paths:** Worker and Wasm URLs resolvable under deployment domain.
5. **Cache Busting:** Content hash in asset filenames.
6. **Runtime Verification:** Verify cross-origin isolation at startup.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | coop_coep_headers_required | Missing headers → capability gate error |
| 2 | wasm_mime_type_check | Non-wasm MIME → descriptive error |
| 3 | worker_path_resolution | Worker URL resolves relative to deployment base |
| 4 | csp_allows_wasm | CSP string includes wasm-unsafe-eval |
| 5 | cross_origin_isolation_runtime | crossOriginIsolated === true at runtime |
| 6 | asset_hash_in_path | Built assets include content hash |

## Must NOT
- Hardcode localhost or dev-only paths
- Use CSP wildcards or unsafe-inline in production
- Serve Wasm with wrong MIME type
- Deploy without COOP/COEP headers

## Must DO
- Define required server headers
- Verify cross-origin isolation at runtime
- Resolve Worker/Wasm paths relative to deployment
- Include content hashes in asset filenames
- Document deployment checklist

## Verification
- All 6 tests green
- Deployment checklist exists
- Runtime isolation check passes/fails correctly
