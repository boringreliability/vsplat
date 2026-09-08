---
epic: "point-cloud-pivot"
name: "LiDAR Point Cloud Pivot"
number: 6
status: "code-complete"
created: "2026-05-26"
---
# Epic 06: LiDAR Point Cloud Pivot

## Goal
Transformere vsplat-motoren fra en beregningstung 3D Gaussian Splatting-viewer til en rå, lynhurtig LiDAR Point Cloud-visualiseringsplatform. Epic'en amputerer de komplekse SH- og covariance-beregninger, og genbruger den eksisterende SoA-arkitektur (Struct of Arrays), OPFS-I/O og Wasm-hukommelsesbro til at skubbe over 20 millioner rå LiDAR-data til skærmen med 60 FPS. Hver Ward inkluderer et eksplicit AI Vision-valideringstrin for at forhindre visuel regression og afkoblede funktioner.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 20 | The Point Cloud Shader & Pipeline Clean | complete |
| 21 | LAS/LAZ Stream Ingestion | complete |
| 22 | Intensity Color-Ramp Mapping | complete |
| 23 | Hardware Z-Buffer Hardening (Massive Scale) | complete |
| 25 | LAZ Decompression | complete |
| 26 | LiDAR Production Path | complete |

## Integration Points
- **Epic 01 (Native Web Foundation):** Genbruger den etablerede OPFS-pipeline, Wasm Worker bridge og zero-copy hukommelsesmodel.
- **Epic 02 (ECS & WebGPU):** Genbruger ECS-kernen (World, EntityManager, ComponentStore) og buffer-upload-mønstre, men erstatter splat-specifikke rendering shaders.
- **Epic 03 (Interaction):** Genbruger CameraSystem (Orbit/Fly) og `ViewProjection` matrix-pipeline. Frustum culling og lasso-selektion genbruges med minimale ændringer, da SoA-layoutet bevares.

## Completion Criteria
- En fuld LAS/LAZ fil kan parses via OPFS og uploade data direkte til WebGPU-buffers uden mellemliggende kopier i JS.
- Scenen kan visualisere over 20 millioner punkter (XYZ + RGB eller Intensitet) med en stabil framerate på over 30 FPS.
- GPU Radix Sort er deaktiveret og erstattet af et velfungerende Hardware Z-Buffer setup.
- Alle 4 Wards har bestået deres respektive AI Vision Validering (bekræftet via visuelle tests på canvas).

## Status 2026-09-04

Alle seks wards er complete, og epic'ens tre tekniske completion criteria er opfyldt i kode:

- ✅ **LAS/LAZ via OPFS uden mellemliggende JS-kopier** — Ward 26. Filen streames fra `File.stream()` til OPFS og til Wasm-parseren i ét gennemløb; kun én chunk er resident ad gangen.
- ✅ **GPU Radix Sort erstattet af hardware Z-buffer** — Ward 20, bekræftet af Ward 23's T1 som regressionsvagt.
- ⚠️ **20M+ punkter @ 30+ FPS** — memory-gaten tillader dem nu (Ward 26), og batching + culling er på plads (Ward 23), men **tallet er ikke målt**. Vores største verificerede fil er 13,5M punkter, og den tager 6,6 s at parse native (se `docs/test-data.md`). Wasm ligger typisk 1,2-2× derover, så budgettet for "visible first frame" er formentlig ikke overholdt ved den størrelse. Dekomprimeringen dominerer.

Det fjerde kriterium — **AI Vision Validering af alle wards** — er ikke opfyldt. V-checkene kræver GPU og rigtige filer og er ikke kørt. `docs/test-data.md` indeholder verificerede LAZ-filer at køre dem med.

Epic'en er altså **code-complete, ikke verificeret**. Den bør ikke lukkes før V-checkene er kørt.
