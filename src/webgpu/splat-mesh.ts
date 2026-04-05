/**
 * Instanced splat mesh — 128 quads per instance for GPU occupancy.
 * Matches PlayCanvas GSplatResourceBase.createMesh().
 *
 * Each quad has 4 vertices with position (cornerX, cornerY, splatOffset).
 * cornerXY ∈ [-1,1], splatOffset ∈ [0,127].
 * 6 indices per quad (two triangles), 128 quads = 768 indices per instance.
 *
 * Vertex shader computes global splat index as:
 *   instanceIndex * 128 + u32(vertex_position.z)
 */

export const SPLATS_PER_INSTANCE = 128;
export const VERTICES_PER_INSTANCE = SPLATS_PER_INSTANCE * 4;  // 512
export const INDICES_PER_INSTANCE = SPLATS_PER_INSTANCE * 6;   // 768

export interface SplatMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

/**
 * Create the instanced splat mesh (vertex + index buffers).
 * Call once at init — reused for all scenes.
 */
export function createSplatMesh(device: GPUDevice): SplatMesh {
  // Build vertex data: 128 quads × 4 vertices × 3 floats (x, y, splatOffset)
  const positions = new Float32Array(VERTICES_PER_INSTANCE * 3);
  const indices = new Uint32Array(INDICES_PER_INSTANCE);

  for (let i = 0; i < SPLATS_PER_INSTANCE; i++) {
    const vBase = i * 4 * 3;
    const iBase = i * 6;
    const vertBase = i * 4;

    // 4 corners: [-1,-1], [1,-1], [1,1], [-1,1]  + z = splatOffset
    positions[vBase]     = -1; positions[vBase + 1] = -1; positions[vBase + 2] = i;
    positions[vBase + 3] =  1; positions[vBase + 4] = -1; positions[vBase + 5] = i;
    positions[vBase + 6] =  1; positions[vBase + 7] =  1; positions[vBase + 8] = i;
    positions[vBase + 9] = -1; positions[vBase + 10] = 1; positions[vBase + 11] = i;

    // 2 triangles per quad
    indices[iBase]     = vertBase;
    indices[iBase + 1] = vertBase + 1;
    indices[iBase + 2] = vertBase + 2;
    indices[iBase + 3] = vertBase;
    indices[iBase + 4] = vertBase + 2;
    indices[iBase + 5] = vertBase + 3;
  }

  const vertexBuffer = device.createBuffer({
    size: positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    label: "splat-mesh-vertices",
  });
  device.queue.writeBuffer(vertexBuffer, 0, positions);

  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    label: "splat-mesh-indices",
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);

  return { vertexBuffer, indexBuffer, indexCount: INDICES_PER_INSTANCE };
}
