/**
 * Ward 026 — normalisering af verdens-koordinater til render-rummet.
 *
 * LiDAR kommer i projicerede koordinater (UTM-easting kan være 600 000 m).
 * f32 har ~7 decimale cifre, så millimeter-detaljer forsvinder hvis man sender
 * de rå tal til GPU'en. Vi centrerer om scenens midte og skalerer til en enhed
 * på ±1 — beregningen sker i f64 og først derefter i f32, som Ward 21's parser
 * også gør det.
 */

export interface NormalizedScene {
  positions: Float32Array;
  /** Scenens midtpunkt i verdens-koordinater. */
  center: [number, number, number];
  /** Faktoren der blev divideret med. */
  scale: number;
}

export function normalizeScene(source: Float32Array): NormalizedScene {
  const count = source.length / 3;
  if (count === 0) {
    return { positions: new Float32Array(0), center: [0, 0, 0], scale: 1 };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i]!, y = source[i + 1]!, z = source[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const center: [number, number, number] = [
    (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
  ];
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const scale = extent > 0 ? extent / 2 : 1;

  const positions = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    positions[i] = (source[i]! - center[0]) / scale;
    positions[i + 1] = (source[i + 1]! - center[1]) / scale;
    positions[i + 2] = (source[i + 2]! - center[2]) / scale;
  }
  return { positions, center, scale };
}
