# Progress — vsplat

## Summary
23 of 25 Wards complete · 249 tests · 0 blocked

## Ward Status
| Ward | Name | Tests | Status | Date |
|------|------|-------|--------|------|
| 001 | Infrastructure & Feature Detection | 6 | ✅ Complete | 2026-03-31 |
| 002 | The OPFS Pipeline | 6 | ✅ Complete | 2026-03-31 |
| 003 | PLY Streaming Parser | 8 | ✅ Complete | 2026-04-01 |
| 004 | 3D ECS Core | 8 | ✅ Complete | 2026-04-01 |
| 005 | WebGPU Low-Copy Bridge & Basic Render | 11 | ✅ Complete | 2026-04-01 |
| 006 | Radix Sort Compute Shader | 10 | ✅ Complete | 2026-04-01 |
| 007 | Splat Fragment Shader (Spherical Harmonics) | 6 | ✅ Complete | 2026-04-01 |
| 008 | 3D Camera & Pointer Interception | 7 | ✅ Complete | 2026-04-01 |
| 009 | Frustum Culling & Hit Testing (Lasso) | 7 | ✅ Complete | 2026-04-01 |
| 010 | Command System & Editor Actions | 8 | ✅ Complete | 2026-04-01 |
| 011 | Export Engine | 7 | ✅ Complete | 2026-04-01 |
| 0122 | Global GPU Radix Sort | 12 | ✅ Complete | 2026-04-01 |
| 0132 | Generational ECS Safety | 11 | ✅ Complete | 2026-04-01 |
| 0141 | Unified SoA Material Core | 11 | ✅ Complete | 2026-04-01 |
| 0152 | Production Worker Runtime | 12 | ✅ Complete | 2026-04-04 |
| 0161 | True Streaming I/O | 7 | ✅ Complete | 2026-04-04 |
| 0172 | Runtime Resilience & Fallbacks | 9 | ✅ Complete | 2026-04-04 |
| 0181 | First Light | 4 | ✅ Complete | 2026-04-05 |
| 019 | Production Rendering | 8 | ⏸️ Deferred | 2026-05-26 |
| 020 | The Point Cloud Shader & Pipeline Clean | 7 | ✅ Complete | 2026-05-27 |
| 021 | LAS/LAZ Stream Ingestion | 9 | ✅ Complete | 2026-05-27 |
| 022 | Intensity Color-Ramp Mapping | 7 | ✅ Complete | 2026-05-27 |
| 023 | Hardware Z-Buffer Hardening (Massive Scale) | 9 | 🔨 Gold (afventer QA1) | - |
| 024 | WebGPU API Migration & Tech Debt | 10 | ✅ Complete | 2026-05-27 |
| 025 | LAZ Decompression | 6 | ✅ Complete | 2026-08-29 |

## Test Summary
- Faktisk kørende: **249** — 46 Rust (`cargo test`) + 203 TypeScript (`vitest`, hvoraf 1 skipped i ward-007)
- Ward 018's A1-test kræver `wasm-pack` på PATH; uden den fejler den med `ENOENT` (miljøkrav, ikke kodefejl)

### Manuelle rettelser af denne fil
`wdd complete` kender ikke `status: deferred` og regenererer Ward 019 som "Planned" — Ward 019's række er sat manuelt, ligesom Ward 023's `gold`-status. Bemærk også at rækkerne 0122/0132/0141/0152/0161/0172/0181 har forvanskede ward-numre fra en tidligere regenerering; de dækker Ward 12-18.
