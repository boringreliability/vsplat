/**
 * Ward 026 — filen fra drop til lager, uden at samle den i JS.
 *
 * Projektets hårde constraint: JS må aldrig holde filindholdet i en
 * `ArrayBuffer`. En 20M-punkts LAZ er hundredvis af megabytes komprimeret og
 * gigabytes dekomprimeret — `file.arrayBuffer()` ville lægge hele molevitten i
 * JS-heapen før noget som helst andet skete.
 *
 * Derfor: `File.stream()` → chunks → sink (OPFS i produktion). Vi ser aldrig
 * mere end én chunk ad gangen, og formatet afgøres af de første bytes i den
 * første chunk — ikke af filendelsen.
 */

import { detectSceneFormat, unsupportedFormatMessage, type SceneFormat } from "./scene-format.js";

/** Hvor bytes skrives hen. I produktion: OPFS (Ward 2/16). */
export interface ChunkSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface LoadedScene {
  format: SceneFormat;
  bytesWritten: number;
}

export interface LoadOptions {
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

export async function loadSceneFile(
  file: File,
  sink: ChunkSink,
  options: LoadOptions = {},
): Promise<LoadedScene> {
  const reader = file.stream().getReader();
  let bytesWritten = 0;
  let format: SceneFormat | null = null;
  // Første chunk kan i teorien være kortere end magic-bytesene; vi samler op
  // til 4 bytes og beslutter derefter. Mere end det gemmer vi aldrig.
  let magic: Uint8Array = new Uint8Array(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);

      if (format === null) {
        if (magic.length < 4) {
          const merged = new Uint8Array(Math.min(4, magic.length + chunk.length));
          merged.set(magic.subarray(0, merged.length));
          merged.set(chunk.subarray(0, merged.length - magic.length), magic.length);
          magic = merged;
        }
        if (magic.length >= 4) {
          format = detectSceneFormat(file.name, magic);
          if (format === null) throw new Error(unsupportedFormatMessage(file.name));
        }
      }

      await sink.write(chunk);
      bytesWritten += chunk.byteLength;
      options.onProgress?.(bytesWritten, file.size);
    }
  } finally {
    reader.releaseLock();
  }

  if (format === null) throw new Error(unsupportedFormatMessage(file.name));
  return { format, bytesWritten };
}
