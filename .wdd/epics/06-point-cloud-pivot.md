---
epic: "point-cloud-pivot"
name: "LiDAR Point Cloud Pivot"
number: 6
status: "active"
created: "2026-05-26"
---
# Epic 06: LiDAR Point Cloud Pivot

## Goal
Transformere vsplat-motoren fra en beregningstung 3D Gaussian Splatting-viewer til en rå, lynhurtig LiDAR Point Cloud-visualiseringsplatform. Epic'en amputerer de komplekse SH- og covariance-beregninger, og genbruger den eksisterende SoA-arkitektur (Struct of Arrays), OPFS-I/O og Wasm-hukommelsesbro til at skubbe over 20 millioner rå LiDAR-data til skærmen med 60 FPS. Hver Ward inkluderer et eksplicit AI Vision-valideringstrin for at forhindre visuel regression og afkoblede funktioner.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 20 | The Point Cloud Shader & Pipeline Clean | planned |
| 21 | LAS/LAZ Stream Ingestion | planned |
| 22 | Intensity Color-Ramp Mapping | planned |
| 23 | Hardware Z-Buffer Hardening (Massive Scale) | planned |

## Integration Points
- **Epic 01 (Native Web Foundation):** Genbruger den etablerede OPFS-pipeline, Wasm Worker bridge og zero-copy hukommelsesmodel.
- **Epic 02 (ECS & WebGPU):** Genbruger ECS-kernen (World, EntityManager, ComponentStore) og buffer-upload-mønstre, men erstatter splat-specifikke rendering shaders.
- **Epic 03 (Interaction):** Genbruger CameraSystem (Orbit/Fly) og `ViewProjection` matrix-pipeline. Frustum culling og lasso-selektion genbruges med minimale ændringer, da SoA-layoutet bevares.

## Completion Criteria
- En fuld LAS/LAZ fil kan parses via OPFS og uploade data direkte til WebGPU-buffers uden mellemliggende kopier i JS.
- Scenen kan visualisere over 20 millioner punkter (XYZ + RGB eller Intensitet) med en stabil framerate på over 30 FPS.
- GPU Radix Sort er deaktiveret og erstattet af et velfungerende Hardware Z-Buffer setup.
- Alle 4 Wards har bestået deres respektive AI Vision Validering (bekræftet via visuelle tests på canvas).
