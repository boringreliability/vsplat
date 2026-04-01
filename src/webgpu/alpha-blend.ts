/**
 * Alpha blending for back-to-front splat compositing.
 *
 * CPU reference implementation. The GPU uses the same formula in the
 * blend state of the render pipeline.
 */

export interface SplatColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Composite splats back-to-front using straight (non-premultiplied) alpha.
 *
 * Input splats use straight alpha: {r, g, b} are the actual color values,
 * and {a} is the opacity (0..1). The function applies the standard
 * over operator internally:
 *
 *   C_out = α * C_splat + (1 - α) * C_behind
 *
 * Splats must be ordered back-to-front (farthest first in the array).
 *
 * @param splats Array of splat colors in back-to-front order
 * @returns Composited {r, g, b} color
 */
export function compositeBackToFront(
  splats: SplatColor[],
): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0;

  for (const splat of splats) {
    const a = splat.a;
    r = a * splat.r + (1 - a) * r;
    g = a * splat.g + (1 - a) * g;
    b = a * splat.b + (1 - a) * b;
  }

  return { r, g, b };
}
