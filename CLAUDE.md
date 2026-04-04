# CLAUDE.md — vsplat

## Bootstrap Protocol
**On every session start, read these files in order:**
1. `.wdd/PROJECT.md` — what this project is (identity, architecture, principles)
2. `.wdd/CONTEXT.md` — where we are right now (current state, constraints, next steps)
3. `.wdd/PROGRESS.md` — what's done (ward status dashboard)
4. The current Ward spec in `.wdd/wards/ward-{NNN}.md` — what we're building now

Do NOT start coding before reading all four files.
Do NOT rely on conversation history — the `.wdd/` files are the source of truth.

## Role Assignment

You are the **implementer** (code slave). You do NOT make architectural decisions.

- **QA1 (Claude Opus in claude.ai)** reviews all specs, tests, and implementations
- **QA2 (GPT 5.4)** provides secondary review
- **You (Claude Code CLI)** write code that matches the spec exactly

When QA1 or QA2 provide review instructions, follow them literally.
When in doubt, stop and ask — do not guess.

## Repository Layout

```
vsplat/
├── .wdd/                        ← Ward-Driven Development workspace
│   ├── PROJECT.md               ← Identity, architecture, principles
│   ├── CONTEXT.md               ← Current state (update after each Ward)
│   ├── PROGRESS.md              ← Ward status dashboard
│   ├── config.json              ← WDD configuration
│   ├── epics/                   ← Epic definitions
│   ├── wards/                   ← Ward specifications (ward-001.md through ward-019.md)
│   ├── memory/snapshots/        ← Per-ward context snapshots
│   └── templates/               ← Ward/epic/decision templates
├── crates/vsplat-core/          ← Rust crate (PLY parser, ECS, FFI)
│   └── src/
│       ├── ply/                 ← PLY header parser + streaming binary parser
│       ├── ecs/                 ← Entity manager, ComponentStore, World, components
│       ├── ffi.rs               ← wasm-bindgen FFI exports (Ward 15)
│       └── lib.rs
├── src/                         ← TypeScript source
│   ├── camera/                  ← Orbit/fly controllers, perspective/lookAt math
│   ├── commands/                ← Command history, DeleteCommand
│   ├── detection/               ← Feature flags (WebGPU, OPFS, memory64)
│   ├── ecs/                     ← EntityHandle, GenerationMap (Ward 13)
│   ├── export/                  ← PLY writer, chunked streaming, download
│   ├── opfs/                    ← OPFS storage utilities
│   ├── selection/               ← Frustum culling, lasso, point-in-polygon
│   ├── webgpu/                  ← GPU buffers, shaders, radix sort, SH eval
│   └── worker/                  ← Worker bridge, message protocol
├── tests/                       ← Test files organized by ward
│   ├── ward-001/ through ward-015/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Methodology: Ward-Driven Development (WDD)

### The Ward Lifecycle
```
Planned → Red (write failing tests) → Approved (QA1 reviews) → Gold (implement) → Complete
```

### GS-TDD Rules
1. **Red phase:** Write ALL tests for the Ward spec FIRST. Every test MUST fail. Run them — confirm red.
2. **QA1 approval gate:** STOP. Present the failing tests. Wait for QA1 to approve before implementing.
3. **Gold phase:** Implement ONLY enough code to make all tests pass. Nothing more.
4. **Gold ≠ Green.** Gold means the quality standard is met — full BDD test suites for entire features.
5. **No stubs, no "v1 tech debt"** unless explicitly planned in a named future Ward.

### Critical Rules
- NEVER skip the QA1 approval gate between Red and Gold
- NEVER mark a Ward as complete without QA1 approval
- ALWAYS run tests before claiming a Ward is complete
- ALWAYS update CONTEXT.md after completing a Ward
- ALWAYS update PROGRESS.md after completing a Ward
- If a Ward has dependencies, verify those Wards are Complete before starting

## Language-Specific Rules

### Rust Tests
- Rust tests are written as `#[cfg(test)]` modules in the relevant source file or a co-located `tests.rs`
- Rust tests run via `cargo test` in `crates/vsplat-core/`
- Rust tests CAN and MUST be written in Red phase — they are normal Rust functions, not dependent on wasm-bindgen
- `#[wasm_bindgen]` is just an annotation — FFI functions are testable as plain Rust functions
- Do NOT defer Rust tests to Gold phase. Write them in Red phase like every other test.

### TypeScript Tests
- TypeScript tests are in `tests/ward-{NNN}/` directories
- Tests run via `npx vitest run`
- WebGPU APIs are mocked (browser-only). Mock infrastructure follows the patterns in existing ward test files.
- GPU stubs: `vi.stubGlobal("GPUBufferUsage", {...})` and `vi.stubGlobal("GPUShaderStage", {...})`

### WGSL Shaders
- WGSL shaders are embedded as template literals in TypeScript files
- Mock `compilationInfo()` does NOT validate WGSL syntax — real validation requires a GPU device
- Common WGSL mistakes that mocks miss: `atomic` write without `atomicStore`, undefined variable names, struct field mismatches
- When writing WGSL: double-check all variable names match their declarations, all atomic buffers use atomic operations, all struct fields match their bindings

## Architecture Principles

- **Rust owns data, JS/WebGPU owns pixels** — all scene data lives in Rust
- **Column-Major matrices everywhere** — WebGPU/WGSL standard, index as `mat[col * 4 + row]`
- **Soft-delete via visibility flags** — no data removal until export
- **Zero-copy where possible** — Wasm memory → Float32Array view → GPU writeBuffer
- **SoA layout** — flat contiguous arrays for GPU upload, no per-entity heap allocations
- **4-bit radix sort on GPU** — 16 buckets, 8 passes (diverges from CPU reference's 8-bit/4-pass)

## Key Conventions

### Buffer Labels
GPU buffers use consistent labels for test assertions:
- `"sort-keys"`, `"sort-indices-a"`, `"sort-indices-b"`
- `"sort-histogram"`, `"sort-scan-aux"`, `"sort-scan-aux2"`, `"sort-scan-aux3"`
- `"sort-params"` (16 bytes: count + shift + numWorkgroups + pad)
- `"sh-coefficients"`, `"opacity"`, `"splat-positions"`

### Visibility Bitflags
```
VISIBLE  = 0x01
SELECTED = 0x02
DELETED  = 0x04
```
Consistent across Rust (`VisibilityFlags`) and TypeScript (`delete.ts`, `gpu-integration.ts`).

### EntityHandle
```typescript
interface EntityHandle { readonly index: number; readonly generation: number; }
```
DeleteCommand accepts `EntityHandle[] | number[]` (backward compat with Ward 10).
GenerationMap is a validation cache, NOT authoritative — Rust owns entity lifecycle.

### Performance Test Policy
- Do NOT assert on timing in unit tests (flaky in CI)
- Measure elapsed time but only log it, don't assert
- Performance verification belongs in browser integration tests (Ward 17+)

## How to Work on a Ward

### Starting a new Ward:
```bash
# 1. Read the Ward spec
cat .wdd/wards/ward-{NNN}.md

# 2. Write ALL failing tests first (Red phase)
#    - TypeScript tests in tests/ward-{NNN}/
#    - Rust tests in crates/vsplat-core/src/{module}/tests.rs

# 3. Run tests — confirm they ALL fail
npx vitest run tests/ward-{NNN}/
cd crates/vsplat-core && cargo test

# 4. STOP. Present tests to human for QA1 review. Wait for approval.

# 5. After approval: implement (Gold phase)
# 6. Run ALL tests — confirm green + no regressions
npx vitest run
cd crates/vsplat-core && cargo test

# 7. Present implementation to human for QA1 review.
```

### After QA1 Approval:
1. Update Ward frontmatter: `status: complete`, `completed: {date}`
2. Update `.wdd/CONTEXT.md`
3. Update `.wdd/PROGRESS.md`

## Epic Structure
- **Epic 01 (Wards 1-3):** Native Web Foundation — feature detection, OPFS, PLY parsing
- **Epic 02 (Wards 4-7):** ECS & WebGPU Engine — ECS, GPU bridge, radix sort, SH shaders
- **Epic 03 (Wards 8-10):** Interaction — camera, frustum/lasso, commands
- **Epic 04 (Ward 11):** Roundtrip — export engine
- **Epic 05 (Wards 12-19):** Production Hardening — global sort, ECS safety, SoA materials, worker runtime, streaming I/O, resilience, deployment, observability
