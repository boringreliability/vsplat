---
ward: 24
revision: null
name: "WebGPU API Migration & Tech Debt"
epic: "point-cloud-pivot"
status: "complete"
dependencies: []
priority: "high"
layer: "typescript+wgsl"
estimated_tests: 10
created: "2026-05-27"
completed: "2026-05-27"
---
# Ward 024: WebGPU API Migration & Tech Debt

## Scope
Oprydningsward der adresserer **tre konkrete tech debt-poster** afdækket under Ward 20's smoke-test og pivot-arbejdet. Kan køres parallelt med Ward 21 (Rust-tung, rører ikke TS-rendering-stacken) — der er ingen inter-ward dependencies. Høj prioritet fordi (1) hele renderings-stacken er reelt ikke-fungerende i ægte browsere lige nu pga. spec-rename, (2) en pre-existing failing test undergraver test-suite-tilliden, og (3) ward-19's "deferred"-status er misrepræsenteret i PROGRESS.md.

## Problem Statement

### Issue 1: WebGPU spec-rename ramte render-moduler — to forskellige tilstande
WebGPU spec'en omdøbte `GPUShaderModule.compilationInfo()` → `getCompilationInfo()`. Chrome 119+ leverer kun det nye navn (gammel returnerer `undefined`). Vores Vitest-mocks bruger det gamle navn, så **alle automated tests passerer, men runtime i ægte browser fejler**.

Berørte filer (verificeret via `grep compilationInfo src/webgpu/*.ts`):

| Fil | Nuværende tilstand | Problem |
|-----|--------------------|---------|
| `src/webgpu/render-pipeline.ts:87` | Ingen feature-detect — kalder `shaderModule.compilationInfo()` direkte | **Kritisk:** Fejler i Chrome 119+ med TypeError |
| `src/webgpu/radix-sort-gpu.ts:186` | Ingen feature-detect — kalder direkte | **Kritisk:** Fejler i Chrome 119+ |
| `src/webgpu/splat-shader.ts:295` | Har feature-detect men **omvendt prioritet**: `compilationInfo ?? getCompilationInfo` | **Mindre:** Virker i Chrome 119+ (?? falder tilbage), men foretrækker deprecated API i ældre versioner |
| `src/webgpu/radix-sort-global.ts:319` | Har feature-detect men **omvendt prioritet** | **Mindre:** Samme som ovenfor |
| `src/webgpu/point-pipeline.ts` (Ward 20) | Korrekt prioritet (`getCompilationInfo ?? compilationInfo`) | ✅ Reference-implementation |

Note: `src/webgpu/depth-keys.ts` har **ingen** `compilationInfo`-kald — den blev tidligere fejlagtigt listet og er fjernet fra scope.

Mål: Alle berørte filer skal følge `point-pipeline.ts`'s mønster (ny API først, gammel som fallback, eksplicit fejl hvis ingen).

### Issue 2: Ward 7 test failure (deferred Ward 19 spillover)
`tests/ward-007/spherical-harmonics.test.ts` fejler på `expect(shaderCode).toContain("conic")` fordi Ward 19's halv-færdige PlayCanvas-port fjernede `conic` fra `splat-shader.ts`. Da Ward 19 nu er deferred, vil shaderen aldrig blive "færdig-portet", og testen skal opdateres til at matche den **deferred-version** af shaderen (eller skip-markeres).

Beslutning til QA1 i Red-fasen: Skal vi (a) skip-markere testen med kommentar, (b) opdatere assertions til at acceptere current shader-state, eller (c) revert shader-koden tilbage til Ward 7's original?

### Issue 3: PROGRESS.md viser "deferred" som "Planned"
`wdd complete <N>` auto-genererer PROGRESS.md ud fra ward-frontmatter, men kender ikke `status: deferred` og defaulter til "Planned". Ward 19 vises forkert hver gang en ward completes. Fix: lille patch til wdd CLI'en eller dokumenteret "manual override"-procedure.

## Inputs
- Ward 20: `point-pipeline.ts`'s `getCompilationInfo` feature-detect-mønster (reference)
- Ward 19: deferred spec og halv-port shader (kontekst)

## Outputs

### Modified: 4 render-moduler (depth-keys.ts fjernet fra scope efter verifikation)
- `src/webgpu/render-pipeline.ts` — tilføj feature-detect (var helt manglende)
- `src/webgpu/radix-sort-gpu.ts` — tilføj feature-detect (var helt manglende)
- `src/webgpu/splat-shader.ts` — ret omvendt prioritet til ny-først
- `src/webgpu/radix-sort-global.ts` — ret omvendt prioritet til ny-først

Alle skal følge samme mønster som Ward 20's `point-pipeline.ts`:
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

## Tests (automated, BDD-pattern)

| # | Test Name | Verifies |
|---|-----------|----------|
| T1 | `render_pipeline_prefers_getCompilationInfo_over_legacy` | Ward 5 modul: ny API foretrækkes når device har begge |
| T2 | `splat_shader_prefers_getCompilationInfo_over_legacy` | Ward 7 modul: prioriteringsrækkefølge rettet |
| T3 | `radix_sort_gpu_prefers_getCompilationInfo_over_legacy` | Ward 6 modul |
| T4 | `radix_sort_global_prefers_getCompilationInfo_over_legacy` | Ward 12 modul: prioriteringsrækkefølge rettet |
| T5 | `render_pipeline_falls_back_to_compilationInfo_when_new_api_missing` | Bagudkompatibel: ældre Chrome |
| T6 | `splat_shader_falls_back_to_compilationInfo_when_new_api_missing` | Bagudkompatibel |
| T7 | `radix_sort_gpu_falls_back_to_compilationInfo_when_new_api_missing` | Bagudkompatibel |
| T8 | `radix_sort_global_falls_back_to_compilationInfo_when_new_api_missing` | Bagudkompatibel |
| T9 | `all_modules_throw_descriptive_error_when_neither_api_present` | Tydelig fejlbesked på alle 4 moduler |
| T10 | `ward_007_test_decision_implemented` | **BLOKERET af QA1 Open Question 1** — kan først skrives når beslutning er truffet |

## Verification (manuel / regression)

- **V1:** Alle 170+ baseline-tests grønne efter migration (regression-gate)
- **V2:** `tests/ward-007/spherical-harmonics.test.ts` status reflekterer QA1's beslutning (skip / fix / revert)
- **V3:** `.wdd/PROGRESS.md` viser Ward 19 som `⏸️ Deferred` (manuel patch efter hver `wdd complete` indtil CLI fixes — dokumenteret som "manual override step")
- **V4:** Browser smoke-test: `points-smoke.html` virker uændret, og `index.html` (Ward 18 splat app) loader uden runtime-fejl i Chrome 119+

## Must NOT
- Ændre adfærd i Ward 5/6/7/12-modulers public API
- Skrive nye Vitest mocks der maskerer ægte browser-fejl (det er problemet vi løser)
- Røre Ward 20's `point-pipeline.ts` (allerede fixed)
- Lave større arkitektur-ændringer — kun målrettet API-migration

## Must DO
- Tilføj feature-detect i `render-pipeline.ts` og `radix-sort-gpu.ts` (mangler helt)
- Rette omvendt prioriteringsrækkefølge i `splat-shader.ts` og `radix-sort-global.ts` (ny API først)
- Træffe beslutning om Ward 7's test-failure (Open Question 1)
- Etablér "manual PROGRESS.md override"-procedure dokumenteret i CLAUDE.md
- Køre alle 170+ baseline tests grønne efter migration
- Dokumentere `getCompilationInfo`-mønstret i CLAUDE.md (under "Architecture Principles" eller "Language-Specific Rules")

## Verification
- T1-T10 grønne i Vitest
- Smoke-test af `points-smoke.html` virker uændret efter migration
- Manuelt: indlæs PLY-fil i `index.html` (Ward 18's app shell) i ægte Chrome → splat-rendering virker uden runtime-fejl

## Open Questions for QA1
1. **Ward 7 test:** Skip eller fix? Forslag: **skip med kommentar** der peger på Ward 19's deferred-status. T10 i testtabellen kan først skrives når dette er besvaret.
2. **PROGRESS.md fix:** Patche wdd CLI'en (separat værktøjs-PR) eller etablere "manual override"-procedure? Forslag: **manual override** i denne ward, CLI-patch i en separat værktøjs-ward udenfor Epic 06.
3. **Browser smoke-test integration:** Skal Ward 24 tilføje `@vitest/browser` for ægte Chrome-test, eller er Vitest-mocks med begge API-navne tilstrækkeligt? Forslag: **Vitest-mocks** for kontrakt-tests (mønster, fallback, error path) — browser-verifikation forbliver manuel V4-step. Tilføjelse af `@vitest/browser` er en infrastruktur-beslutning der hører til en separat ward.
