/**
 * Ward 023 — draw-call planlægning for batched point rendering.
 *
 * Broen mellem `BatchManager` (som deler scenen i k-d-batches) og render-loopet
 * (som skal udstede ét `draw()` per synlig batch). Uden dette lag ligger
 * batching og culling som ubrugte biblioteker ved siden af en enkelt
 * 20M-vertex draw call — præcis den driver-timeout Ward 23 skal fjerne.
 *
 * Planlægningen er ren og synkron, så den kan testes uden GPU.
 */

import type { Batch } from "./batch-manager.js";
import { cullBatch } from "./frustum-cull.js";

/** Et sammenhængende punkt-interval der kan tegnes med ét `draw()`-kald. */
export interface DrawRange {
  firstPoint: number;
  pointCount: number;
}

export interface DrawPlan {
  ranges: DrawRange[];
  visibleBatches: number;
  totalBatches: number;
  drawnPoints: number;
  totalPoints: number;
}

/**
 * Vælg de batches der er synlige og slå naboer sammen til færrest mulige
 * draw-ranges.
 *
 * `BatchManager` pakker punkterne om så hver batch er en sammenhængende slice,
 * så to synlige nabo-batches kan tegnes med ét kald. Det er gratis at gøre:
 * intervallerne er allerede sorteret efter `firstPoint`.
 */
export function planBatchDraws(batches: Batch[], planes: Float32Array): DrawPlan {
  const ranges: DrawRange[] = [];
  let visibleBatches = 0;
  let drawnPoints = 0;
  let totalPoints = 0;

  for (const batch of batches) {
    totalPoints += batch.pointCount;
    if (cullBatch(batch.aabb, planes)) continue;

    visibleBatches++;
    drawnPoints += batch.pointCount;

    const last = ranges[ranges.length - 1];
    if (last && last.firstPoint + last.pointCount === batch.firstPoint) {
      last.pointCount += batch.pointCount;
    } else {
      ranges.push({ firstPoint: batch.firstPoint, pointCount: batch.pointCount });
    }
  }

  return {
    ranges,
    visibleBatches,
    totalBatches: batches.length,
    drawnPoints,
    totalPoints,
  };
}

/**
 * Vertex-parametre til `pass.draw()` for én range.
 *
 * Ward 23's colored pipeline bruger triangle-list med 6 vertices per punkt,
 * så både antal og offset ganges med 6.
 */
export const VERTICES_PER_POINT = 6;

export function drawArgsFor(range: DrawRange): { vertexCount: number; firstVertex: number } {
  return {
    vertexCount: range.pointCount * VERTICES_PER_POINT,
    firstVertex: range.firstPoint * VERTICES_PER_POINT,
  };
}
