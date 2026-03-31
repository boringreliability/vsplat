/**
 * OPFS Storage utilities.
 * Handles writing files to OPFS and providing sync access handles for Rust.
 */

export interface OpfsStorage {
  /** Get the OPFS root directory handle */
  readonly root: FileSystemDirectoryHandle;
}

/** Initialize OPFS storage — validates access to navigator.storage.getDirectory() */
export async function initOpfsStorage(): Promise<OpfsStorage> {
  const root = await navigator.storage.getDirectory();
  return { root };
}

/**
 * Stream a File/Blob to OPFS in chunks via WritableStream.
 * Never loads the entire file into memory.
 */
export async function writeFileToOpfs(
  root: FileSystemDirectoryHandle,
  fileName: string,
  file: File | Blob,
): Promise<FileSystemFileHandle> {
  const fileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
  let offset = 0;

  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, end);
    await writable.write(chunk);
    offset = end;
  }

  await writable.close();
  return fileHandle;
}

/**
 * Get the size of a file stored in OPFS.
 */
export async function getOpfsFileSize(
  fileHandle: FileSystemFileHandle,
): Promise<number> {
  const file = await fileHandle.getFile();
  return file.size;
}

/**
 * Request a FileSystemSyncAccessHandle for synchronous reads.
 * MUST be called from a dedicated Worker context.
 */
export async function requestSyncAccessHandle(
  fileHandle: FileSystemFileHandle,
): Promise<FileSystemSyncAccessHandle> {
  return await fileHandle.createSyncAccessHandle();
}

/**
 * Read a specific byte range from a SyncAccessHandle.
 */
export function readChunkFromHandle(
  handle: FileSystemSyncAccessHandle,
  offset: number,
  length: number,
): Uint8Array {
  const buffer = new Uint8Array(length);
  handle.read(buffer, { at: offset });
  return buffer;
}

/**
 * Delete a file from OPFS.
 */
export async function deleteOpfsFile(
  root: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  await root.removeEntry(fileName);
}
