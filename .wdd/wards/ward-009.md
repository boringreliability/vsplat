---
ward: 9
revision: null
name: "Frustum Culling & Hit Testing (Lasso)"
epic: "interaction-mlp"
status: "complete"
dependencies: [8]
layer: "rust"
estimated_tests: 7
created: "2026-03-31"
completed: "2026-04-01"
---
# Ward 009: Frustum Culling & Hit Testing (Lasso)

## Scope
Lynhurtig udvælgelse af tusindvis af splats via 2D Lasso-selektion. Projicer 3D splats til 2D skærmkoordinater og brug point-in-polygon til at markere dem.

## Inputs
- Ward 8: Camera system med ViewProjection matrix

## Outputs
- Frustum culling system
- 2D Lasso tegne-tool (JS)
- Point-in-polygon hit testing (Rust)
- Selection state i ECS (Visibility.selected bitflag)

## Specification
1. **Frustum Culling (Rust):**
   - Extract 6 frustum planes fra ViewProjection matrix
   - Test splat positions mod planes
   - Skip culled splats i render og selection

2. **Lasso Tool (JS):**
   - Pointer Events: tegn freeform polygon på canvas overlay
   - Send polygon vertices til Rust når lasso lukkes
   - Visual feedback i real-time

3. **Hit Testing (Rust):**
   - Modtag 2D polygon fra JS
   - Projicer kun frustum-visible 3D splats til 2D skærmkoordinater
   - Ray-casting point-in-polygon test
   - Markér matchende entities med Visibility.selected bitflag

4. **Selection State:**
   - Selected splats highlightes visuelt
   - Multi-select: Shift+Lasso tilføjer til eksisterende selektion
   - Escape: clear selection

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | frustum_planes_extraction | Korrekte frustum planes fra VP matrix |
| 2 | frustum_cull_outside | Splats udenfor frustum returneres ikke |
| 3 | frustum_cull_inside | Splats indenfor frustum returneres |
| 4 | point_in_polygon_inside | Punkt inde i polygon detekteres |
| 5 | point_in_polygon_outside | Punkt udenfor polygon afvises |
| 6 | lasso_select_marks_entities | Lasso-selektion sætter Visibility.selected |
| 7 | lasso_performance_5m | Lasso over 5M splats < 20ms |

## Must NOT
- Send polygonen til GPU'en for selektion — selektion tilhører ECS (Rust)
- Bruge bounding box approximation for lasso
- Teste alle splats — kun frustum-visible splats skal testes

## Must DO
- Implementer 2D Lasso-selektion
- Projicer 3D splats inden for frustum til 2D skærmkoordinater
- Brug Ray-casting point-in-polygon algoritme
- Frustum culling som pre-filter

## Verification
- Alle 7 tests er grønne
- Lasso selection af 5M splats < 20ms
- Kun splats inden for lasso markeres visuelt
