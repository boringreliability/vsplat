---
ward: 24
revision: null
name: "WebGPU API Migration & Tech Debt"
epic: "point-cloud-pivot"
status: "planned"
dependencies: []
priority: "high"
layer: "typescript+wgsl"
estimated_tests: 10
created: "2026-05-27"
completed: null
---
# Ward 024: WebGPU API Migration & Tech Debt

## Scope
Oprydningsward der adresserer **tre konkrete tech debt-poster** afdækket under Ward 20's smoke-test og pivot-arbejdet. Kan køres parallelt med Ward 21 (Rust-tung, rører ikke TS-rendering-stacken) — der er ingen inter-ward dependencies. Høj prioritet fordi (1) hele renderings-stacken er reelt ikke-fungerende i ægte browsere lige nu pga. spec-rename, (2) en pre-existing failing test undergraver test-suite-tilliden, og (3) ward-19's "deferred"-status er misrepræsenteret i PROGRESS.md.

## Problem Statement

### Issue 1: WebGPU spec-rename ramte alle render-moduler
WebGPU spec'en omdøbte `GPUShaderModule.compilationInfo()` → `getCompilationInfo()`. Chrome 119+ understøtter kun det nye navn. Vores Vitest-mocks bruger det gamle navn, så **alle automated tests passerer, men runtime i ægte browser fejler med "compilationInfo is not a function"**.

Berørte filer:
- `src/webgpu/render-pipeline.ts:87` (Ward 5)
- `src/webgpu/splat-shader.ts` (Ward 7)
- `src/webgpu/radix-sort-gpu.ts` (Ward 6)
- `src/webgpu/radix-sort-global.ts` (Ward 12)
- `src/webgpu/depth-keys.ts` (Ward 12)
- Eventuelle andre `device.createShaderModule(...)` call sites

Ward 20 har allerede fix'et det i `point-pipeline.ts` med et `getCompilationInfo ?? compilationInfo` feature-detect-mønster. Det mønster spredes til alle andre moduler.

### Issue 2: Ward 7 test failure (deferred Ward 19 spillover)
`tests/ward-007/spherical-harmonics.test.ts` fejler på `expect(shaderCode).toContain("conic")` fordi Ward 19's halv-færdige PlayCanvas-port fjernede `conic` fra `splat-shader.ts`. Da Ward 19 nu er deferred, vil shaderen aldrig blive "færdig-portet", og testen skal opdateres til at matche den **deferred-version** af shaderen (eller skip-markeres).

Beslutning til QA1 i Red-fasen: Skal vi (a) skip-markere testen med kommentar, (b) opdatere assertions til at acceptere current shader-state, eller (c) revert shader-koden tilbage til Ward 7's original?

### Issue 3: PROGRESS.md viser "deferred" som "Planned"
`wdd complete <N>` auto-genererer PROGRESS.md ud fra ward-frontmatter, men kender ikke `status: deferred` og defaulter til "Planned". Ward 19 vises forkert hver gang en ward completes. Fix: lille patch til wdd CLI'en eller dokumenteret "manual override"-procedure.

## Inputs
- Ward 20: `point-pipeline.ts`'s `getCompilationInfo` feature-detect-mønster (reference)
- Ward 19: deferred spec og halv-port shader (kontekst)

## Outputs

### Modified: `src/webgpu/{render-pipeline,splat-shader,radix-sort-gpu,radix-sort-global,depth-keys}.ts`
Hver fil's `shaderModule.compilationInfo()` kald erstattes med samme feature-detect-pattern som Ward 20:
```ts
const sm = shaderModule as GPUShaderModule & {
  getCompilationInfo?: () => Promise<GPUCompilationInfo>;
  compilationInfo?: () => Promise<GPUCompilationInfo>;
};
const getInfo = sm.getCompilationInfo ?? sm.compilationInfo;
if (!getInfo) throw new Error("...");
const info = await getInfo.call(sm);
```

### Modified: `tests/ward-007/spherical-harmonics.test.ts`
Enten:
- Skip-marker tests der refererer til "conic" med `it.skip(...)` + kommentar
- Opdater assertions til at matche current shader-state
- (Skal afgøres af QA1 i Red-fasen)

### Modified: `.wdd/PROGRESS.md` (manuel patch eller via CLI)
Ward 19 skal vises som `⏸️ Deferred` ikke `📋 Planned`. Hvis wdd CLI ikke understøtter det, dokumentér "manual override after auto-generation"-procedure i CLAUDE.md.

### New: `tests/ward-024/api-compat.test.ts`
Browser-integration smoke der verificerer at alle render-moduler kan instantiere en pipeline mod en ægte (eller fuldt mock'et med begge API-navne) `GPUDevice`. Cross-stage contract-test mellem Vitest-mocks og runtime-browser API.

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `render_pipeline_uses_getCompilationInfo_when_available` | Ward 5 modul foretrækker nye API når device har begge |
| T2 | `splat_shader_uses_getCompilationInfo_when_available` | Ward 7 modul samme adfærd |
| T3 | `radix_sort_gpu_uses_getCompilationInfo` | Ward 6 modul |
| T4 | `radix_sort_global_uses_getCompilationInfo` | Ward 12 modul |
| T5 | `depth_keys_uses_getCompilationInfo` | Ward 12 modul |
| T6 | `fallback_to_compilationInfo_when_new_api_missing` | Bagudkompatibel: ældre Chrome kører |
| T7 | `throws_descriptive_error_when_neither_api_present` | Tydelig fejlbesked til diagnose |
| T8 | `ward_007_test_no_longer_fails` | Ward 7 test enten skipped eller passes |
| T9 | `progress_md_shows_ward_019_as_deferred` | PROGRESS.md viser korrekt status |
| T10 | `all_existing_tests_remain_green` | Regression-gate: 170+ baseline-tests grønne |

## Must NOT
- Ændre adfærd i Ward 5/6/7/12-modulers public API
- Skrive nye Vitest mocks der maskerer ægte browser-fejl (det er problemet vi løser)
- Røre Ward 20's `point-pipeline.ts` (allerede fixed)
- Lave større arkitektur-ændringer — kun målrettet API-migration

## Must DO
- Spread `getCompilationInfo` feature-detect til alle berørte moduler
- Træffe beslutning om Ward 7's test-failure (skip vs. fix)
- Sikre at PROGRESS.md korrekt viser Ward 19 som deferred
- Køre alle 170+ baseline tests grønne efter migration
- Dokumentere mønstret i CLAUDE.md så fremtidige spec-renames fanges hurtigere

## Verification
- T1-T10 grønne i Vitest
- Smoke-test af `points-smoke.html` virker uændret efter migration
- Manuelt: indlæs PLY-fil i `index.html` (Ward 18's app shell) i ægte Chrome → splat-rendering virker uden runtime-fejl

## Open Questions for QA1
1. **Ward 7 test:** Skip eller fix? Mit forslag er **skip med kommentar** der peger på Ward 19's deferred-status
2. **PROGRESS.md fix:** Skal vi patche wdd CLI'en (en separat værktøj-PR) eller bare etablere "manual override"-procedure?
3. **Browser smoke-test integration:** Skal `tests/ward-024/api-compat.test.ts` bruge `@vitest/browser` (kører i ægte Chrome), eller er klassisk Vitest-mock med begge API-navne tilstrækkeligt?
