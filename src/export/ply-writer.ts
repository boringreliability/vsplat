/**
 * PLY binary writer: generates header and serializes active splats.
 *
 * Filters out DELETED splats and writes only active data in binary
 * little-endian format matching the PLY specification.
 *
 * Supports all PLY property types: float, double, uchar, short, ushort, int, uint.
 * Stride is computed from actual property sizes (not assumed to be 4 bytes).
 */

const DELETED = 0x04;

/** PLY property definition for header and stride calculation. */
export interface PropertyDef {
  name: string;
  type: "float" | "double" | "uchar" | "int" | "uint" | "short" | "ushort";
}

/** Byte size per property type. */
export function propertySize(type: PropertyDef["type"]): number {
  switch (type) {
    case "float": return 4;
    case "double": return 8;
    case "uchar": return 1;
    case "short": case "ushort": return 2;
    case "int": case "uint": return 4;
  }
}

/** Compute stride (total bytes per vertex) from property definitions. */
export function computeStride(properties: PropertyDef[]): number {
  return properties.reduce((sum, p) => sum + propertySize(p.type), 0);
}

/**
 * Count active (non-deleted) splats.
 */
export function countActive(visibility: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < visibility.length; i++) {
    if (!(visibility[i] & DELETED)) count++;
  }
  return count;
}

/**
 * Generate a PLY ASCII header for the active splats.
 */
export function generatePlyHeader(
  properties: PropertyDef[],
  visibility: Uint8Array,
): string {
  const activeCount = countActive(visibility);

  const lines = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${activeCount}`,
  ];

  for (const prop of properties) {
    lines.push(`property ${prop.type} ${prop.name}`);
  }

  lines.push("end_header");

  return lines.join("\n") + "\n";
}

/**
 * Write a single property value to a DataView at the given offset.
 * Uses the correct DataView method based on property type (little-endian).
 *
 * @returns Number of bytes written (the property's size)
 */
export function writeProperty(
  view: DataView,
  offset: number,
  prop: PropertyDef,
  value: number,
): number {
  switch (prop.type) {
    case "float":
      view.setFloat32(offset, value, true);
      return 4;
    case "double":
      view.setFloat64(offset, value, true);
      return 8;
    case "uchar":
      view.setUint8(offset, value);
      return 1;
    case "short":
      view.setInt16(offset, value, true);
      return 2;
    case "ushort":
      view.setUint16(offset, value, true);
      return 2;
    case "int":
      view.setInt32(offset, value, true);
      return 4;
    case "uint":
      view.setUint32(offset, value, true);
      return 4;
  }
}

/** Read a property value for splat i from the data object. */
export function readProperty(
  name: string,
  splatIndex: number,
  data: { positions: Float32Array; opacities: Float32Array; [key: string]: Float32Array },
): number {
  switch (name) {
    case "x": return data.positions[splatIndex * 3];
    case "y": return data.positions[splatIndex * 3 + 1];
    case "z": return data.positions[splatIndex * 3 + 2];
    case "opacity": return data.opacities[splatIndex];
    default: {
      const arr = data[name];
      return arr ? arr[splatIndex] : 0;
    }
  }
}

/**
 * Serialize active splats to a binary ArrayBuffer.
 *
 * Uses the correct DataView method per property type. Stride is computed
 * from actual property sizes, not assumed to be 4 bytes.
 *
 * @throws If data arrays are too small for visibility.length splats
 */
export function serializeSplats(
  properties: PropertyDef[],
  data: { positions: Float32Array; opacities: Float32Array; [key: string]: Float32Array },
  visibility: Uint8Array,
): ArrayBuffer {
  const totalSplats = visibility.length;

  // Validate ALL data arrays referenced by properties
  const requiredSize = (key: string) => key === "positions" ? totalSplats * 3 : totalSplats;

  // Map property names to their data array keys
  const propToKey = (name: string): string => {
    if (name === "x" || name === "y" || name === "z") return "positions";
    if (name === "opacity") return "opacities";
    return name;
  };

  const checkedKeys = new Set<string>();
  for (const prop of properties) {
    const key = propToKey(prop.name);
    if (checkedKeys.has(key)) continue;
    checkedKeys.add(key);

    const arr = data[key];
    if (!arr) {
      throw new Error(`Missing data array for property "${prop.name}" (expected data["${key}"])`);
    }
    const needed = requiredSize(key);
    if (arr.length < needed) {
      throw new Error(
        `Data array "${key}" too small: need ${needed}, got ${arr.length}`,
      );
    }
  }

  const activeCount = countActive(visibility);
  const stride = computeStride(properties);
  const buffer = new ArrayBuffer(activeCount * stride);
  const view = new DataView(buffer);

  let writeOffset = 0;

  for (let i = 0; i < totalSplats; i++) {
    if (visibility[i] & DELETED) continue;

    for (const prop of properties) {
      const val = readProperty(prop.name, i, data);
      writeOffset += writeProperty(view, writeOffset, prop, val);
    }
  }

  return buffer;
}
