/**
 * Ward 026 — hvilken slags scene er den droppede fil?
 *
 * Detektion sker på magic bytes, ikke på filendelse. En `.laz` er en LAS-fil
 * for os (Ward 25 dekomprimerer transparent), og en fil med forkert endelse
 * skal stadig virke. Endelsen bruges kun til at gøre fejlbeskeder læselige.
 */

export type SceneFormat = "ply" | "las";

const LASF = [0x4c, 0x41, 0x53, 0x46]; // "LASF"
const PLY = [0x70, 0x6c, 0x79];        // "ply"

function startsWith(head: Uint8Array, magic: number[]): boolean {
  if (head.length < magic.length) return false;
  return magic.every((b, i) => head[i] === b);
}

/**
 * @param fileName kun til fejlbeskeder — aldrig til selve beslutningen
 * @param head de første bytes af filen (mindst 4)
 * @returns formatet, eller `null` hvis filen ikke er nogen af delene
 */
export function detectSceneFormat(fileName: string, head: Uint8Array): SceneFormat | null {
  void fileName;
  if (startsWith(head, LASF)) return "las";
  if (startsWith(head, PLY)) return "ply";
  return null;
}

/** Menneskelæselig afvisning når `detectSceneFormat` gav `null`. */
export function unsupportedFormatMessage(fileName: string): string {
  return `"${fileName}" er hverken en LAS/LAZ-fil (magic "LASF") eller en PLY-fil (magic "ply").`;
}
