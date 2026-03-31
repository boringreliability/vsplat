---
epic: "ecs-webgpu-engine"
name: "3D ECS & The WebGPU Engine"
number: 2
status: "active"
created: "2026-03-31"
---
# Epic 02: 3D ECS & The WebGPU Engine

## Goal
Bygge den datadrevne hjerte-motor og få de rå pixels på skærmen med 60 FPS. Fra ECS til GPU-accelereret rendering med Spherical Harmonics.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 4 | 3D ECS Core (Porting vcore) | planned |
| 5 | WebGPU Low-Copy Bridge & Basic Render | planned |
| 6 | Radix Sort Compute Shader | planned |
| 7 | Splat Fragment Shader (Spherical Harmonics) | planned |

## Integration Points
- Input fra Epic 1 Ward 3 (parsed PLY data) → Ward 4 (ECS batch spawn)
- ECS query API bruges af Epic 3 (selection, commands)
- Render pipeline bruges af Epic 3 (camera, selection highlighting)

## Completion Criteria
- Fotorealistisk rendering af 3DGS scener med SH evaluation
- 60 FPS ved 5M splats (< 16ms total frametime)
- GPU Radix Sort < 4ms per frame
