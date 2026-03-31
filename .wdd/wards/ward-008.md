---
ward: 8
revision: null
name: "3D Camera & Pointer Interception"
epic: "interaction-mlp"
status: "planned"
dependencies: [7]
layer: "typescript"
estimated_tests: 7
created: "2026-03-31"
completed: null
---
# Ward 008: 3D Camera & Pointer Interception

## Scope
Navigation i 3D-rummet med Orbit og Fly controls. Pointer Events i JS-laget sender kontinuerligt opdateret ViewProjection matrix til Rust og WebGPU.

## Inputs
- Ward 7: Komplet render pipeline med SH shaders

## Outputs
- Orbit camera controller (rotate, zoom, pan)
- Fly camera controller (WASD + mouse look)
- ViewProjection matrix pipeline til GPU
- Pointer event system

## Specification
1. **Camera Math (JS/TS):**
   - Perspective projection matrix (fov, aspect, near, far)
   - View matrix fra position + target (lookAt)
   - Combined ViewProjection matrix
   - Beregn matricen én gang per frame

2. **Orbit Controller:**
   - Left mouse drag: rotate around target
   - Scroll wheel: zoom (dolly) ind/ud
   - Middle mouse drag: pan
   - Smooth damping/inertia

3. **Fly Controller:**
   - WASD: bevægelse
   - Mouse look: rotation
   - Shift: hurtigere bevægelse
   - Toggle mellem Orbit og Fly mode

4. **Matrix Pipeline:**
   - Upload ViewProjection matrix til GPU uniform buffer hvert frame
   - Upload camera position (for SH evaluation og depth sort)

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | perspective_matrix_correct | Perspektiv matrix matcher reference |
| 2 | lookat_matrix_correct | LookAt matrix matcher reference |
| 3 | orbit_rotate | Rotation ændrer view matrix korrekt |
| 4 | orbit_zoom | Zoom ændrer afstand til target |
| 5 | orbit_pan | Pan flytter target og position |
| 6 | fly_wasd_movement | WASD bevæger kamera i korrekt retning |
| 7 | matrix_upload_per_frame | ViewProjection uploades til GPU hvert frame |

## Must NOT
- Læg kameramatematikken inde i shaderen
- Bruge third-party camera libraries
- Ignorér pointer lock for fly mode

## Must DO
- Implementer Orbit/Fly controls i JS-laget (Pointer Events)
- Send kontinuerligt opdateret ViewProjection matrix til Rust og WebGPU
- Smooth damping på orbit controls
- Toggle mellem Orbit og Fly mode

## Verification
- Alle 7 tests er grønne
- Smooth 60fps rotation og zoom
- Fly mode føles responsive (< 1 frame input lag)
