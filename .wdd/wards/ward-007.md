---
ward: 7
revision: null
name: "Splat Fragment Shader (Spherical Harmonics)"
epic: "ecs-webgpu-engine"
status: "complete"
dependencies: [6]
layer: "wgsl"
estimated_tests: 6
created: "2026-03-31"
completed: "2026-04-01"
---
# Ward 007: Splat Fragment Shader (Spherical Harmonics)

## Scope
Fotorealistisk rendering af 3D Gaussians. Projicér 3D Gaussians til 2D og evaluer Spherical Harmonics koefficienter baseret på kameravinkel for korrekte refleksioner og genskin.

## Inputs
- Ward 6: Sorteret render pipeline, depth-sorted index buffer

## Outputs
- 3D Gaussian → 2D projection i vertex shader
- SH evaluation i fragment shader
- View-dependent farver (refleksioner)
- Fotorealistisk output

## Specification
1. **3D Gaussian Projection (Vertex Shader):**
   - Input: 3D position, 3D covariance (fra rotation + scale)
   - Beregn 3D covariance matrix fra quaternion rotation + scale
   - Projicer 3D covariance til 2D via Jacobian af perspektiv-projektion
   - Output: 2D center, 2D covariance, opacity

2. **Gaussian Evaluation (Fragment Shader):**
   - Evaluer 2D Gaussian: `exp(-0.5 * (x^T * Σ^-1 * x))`
   - Multiplicer med opacity
   - Discard fragments under threshold

3. **Spherical Harmonics Evaluation:**
   - Input: SH koefficienter (op til degree 3 = 48 floats per splat)
   - Input: view direction (kamera → splat vektor)
   - Evaluer SH basis funktioner for den givne retning
   - Output: RGB farve der varierer med synsvinkel

4. **Alpha Blending:**
   - Back-to-front compositing
   - Premultiplied alpha for korrekt blending

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | covariance_3d_to_2d | 3D covariance projiceres korrekt til 2D |
| 2 | gaussian_evaluation_correct | 2D Gaussian evaluering matcher reference |
| 3 | sh_degree_0_rgb | SH degree 0 (DC) giver korrekt konstant farve |
| 4 | sh_degree_1_view_dependent | SH degree 1 farve ændres med view direction |
| 5 | sh_degree_3_full | Fuld SH evaluation matcher reference implementation |
| 6 | alpha_blending_compositing | Korrekt compositing af overlappende splats |

## Must NOT
- Brug simple farver, hvis SH-data eksisterer i .ply filen
- Evaluer SH på CPU'en (skal ske i shader)
- Ignorér view-direction afhængighed

## Must DO
- Evaluer de 3D Gaussians projiceret til 2D (Splatting)
- Evaluer SH koefficienterne baseret på kameraets synsvinkel
- Support SH degree 0-3 (graceful degradation)

## Verification
- Alle 6 tests er grønne
- Fotorealistisk rendering sammenlignet med reference viewer
- View-dependent farveændringer ved kamerarotation
- Total render time < 10ms for 5M splats
