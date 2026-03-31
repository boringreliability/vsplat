---
epic: "interaction-mlp"
name: "Interaction & The MLP Features"
number: 3
status: "active"
created: "2026-03-31"
---
# Epic 03: Interaction & The MLP Features

## Goal
Give artisten kirurgiske værktøjer til at navigere, vælge og redigere i scenen. Fra kamera-kontrol til Lasso-selektion og Undo/Redo.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 8 | 3D Camera & Pointer Interception | planned |
| 9 | Frustum Culling & Hit Testing (Lasso) | planned |
| 10 | Command System & Editor Actions | planned |

## Integration Points
- Afhænger af Epic 2's render pipeline og ECS
- Camera matrix bruges af Ward 6 (depth sort) og Ward 7 (SH evaluation)
- Command system bruges af Epic 4 (export filtrerer deleted entities)

## Completion Criteria
- Smooth 3D navigation med Orbit og Fly mode
- Lasso-selektion af tusindvis af splats < 20ms
- Instant Delete + Undo/Redo
