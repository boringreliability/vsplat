/**
 * Ward 002 — OPFS Pipeline Tests
 *
 * Tests the complete pipeline: OPFS init → file write → size verify →
 * sync access handle → chunk read → cleanup.
 *
 * Since OPFS is a browser-only API, we mock the FileSystem API surface
 * to test our logic without a browser environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initOpfsStorage,
  writeFileToOpfs,
  getOpfsFileSize,
  requestSyncAccessHandle,
  readChunkFromHandle,
  deleteOpfsFile,
} from "../../src/opfs/storage.js";

// ─── OPFS Mock Infrastructure ──────────────────────────────────
// Simulates the browser's File System API in a Node test environment.

/** In-memory file store backing our mock OPFS */
const mockFileStore = new Map<string, Uint8Array>();

function createMockDirectoryHandle(): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name: "root",

    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!mockFileStore.has(name) && !options?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      if (options?.create && !mockFileStore.has(name)) {
        mockFileStore.set(name, new Uint8Array(0));
      }
      return createMockFileHandle(name);
    },

    async removeEntry(name: string) {
      if (!mockFileStore.has(name)) {
        throw new DOMException("File not found", "NotFoundError");
      }
      mockFileStore.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;
}

function createMockFileHandle(name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,

    async getFile() {
      const data = mockFileStore.get(name) ?? new Uint8Array(0);
      return new File([data], name);
    },

    async createWritable() {
      const chunks: Uint8Array[] = [];
      return {
        async write(data: BufferSource | Blob | string) {
          if (data instanceof Blob) {
            const buf = await data.arrayBuffer();
            chunks.push(new Uint8Array(buf));
          } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            chunks.push(new Uint8Array(
              data instanceof ArrayBuffer ? data : data.buffer,
            ));
          }
        },
        async close() {
          // Concatenate all chunks into a single Uint8Array
          const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          mockFileStore.set(name, merged);
        },
      } as unknown as FileSystemWritableFileStream;
    },

    async createSyncAccessHandle() {
      return createMockSyncAccessHandle(name);
    },
  } as unknown as FileSystemFileHandle;
}

function createMockSyncAccessHandle(name: string): FileSystemSyncAccessHandle {
  let closed = false;

  return {
    read(buffer: ArrayBufferView, options?: { at?: number }) {
      if (closed) throw new DOMException("Handle closed", "InvalidStateError");
      const data = mockFileStore.get(name);
      if (!data) throw new DOMException("File not found", "NotFoundError");

      const offset = options?.at ?? 0;
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const available = Math.min(target.byteLength, data.byteLength - offset);
      target.set(data.subarray(offset, offset + available));
      return available;
    },

    getSize() {
      if (closed) throw new DOMException("Handle closed", "InvalidStateError");
      return mockFileStore.get(name)?.byteLength ?? 0;
    },

    flush() {
      if (closed) throw new DOMException("Handle closed", "InvalidStateError");
    },

    close() {
      closed = true;
    },
  } as unknown as FileSystemSyncAccessHandle;
}

// ─── Tests ─────────────────────────────────────────────────────

describe("Ward 002: OPFS Pipeline", () => {
  beforeEach(() => {
    mockFileStore.clear();

    // Mock navigator.storage.getDirectory()
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDirectoryHandle()),
      },
    });
  });

  // ─── Test 1: opfs_storage_init ───────────────────────────────
  it("should initialize OPFS storage via navigator.storage.getDirectory()", async () => {
    // Given: a browser with OPFS support (mocked above)

    // When: we initialize OPFS storage
    const storage = await initOpfsStorage();

    // Then: we should get a valid storage object with a root handle
    expect(storage).toBeDefined();
    expect(storage.root).toBeDefined();
    expect(storage.root.kind).toBe("directory");
  });

  // ─── Test 2: write_stream_to_opfs ────────────────────────────
  it("should stream a File/Blob to OPFS in chunks", async () => {
    // Given: a simulated .ply file (1KB of test data)
    const testData = new Uint8Array(1024);
    for (let i = 0; i < testData.length; i++) testData[i] = i % 256;
    const testFile = new File([testData], "scene.ply");

    const root = createMockDirectoryHandle();

    // When: we write the file to OPFS
    const fileHandle = await writeFileToOpfs(root, "scene.ply", testFile);

    // Then: the file should exist in our mock store
    expect(fileHandle).toBeDefined();
    expect(fileHandle.name).toBe("scene.ply");
    expect(mockFileStore.has("scene.ply")).toBe(true);
  });

  // ─── Test 3: verify_file_size_in_opfs ────────────────────────
  it("should preserve exact file size after writing to OPFS", async () => {
    // Given: a file with a known size
    const size = 4096;
    const testData = new Uint8Array(size);
    for (let i = 0; i < size; i++) testData[i] = i % 256;
    const testFile = new File([testData], "exact-size.ply");

    const root = createMockDirectoryHandle();

    // When: we write and then check the size
    const fileHandle = await writeFileToOpfs(root, "exact-size.ply", testFile);
    const storedSize = await getOpfsFileSize(fileHandle);

    // Then: the stored file should have the exact same size
    expect(storedSize).toBe(size);
  });

  // ─── Test 4: request_sync_access_handle ──────────────────────
  it("should obtain a SyncAccessHandle for synchronous reads", async () => {
    // Given: a file stored in OPFS
    mockFileStore.set("test.ply", new Uint8Array([1, 2, 3, 4, 5]));
    const fileHandle = createMockFileHandle("test.ply");

    // When: we request a sync access handle
    const syncHandle = await requestSyncAccessHandle(fileHandle);

    // Then: it should be a valid handle with read/getSize/close methods
    expect(syncHandle).toBeDefined();
    expect(typeof syncHandle.read).toBe("function");
    expect(typeof syncHandle.getSize).toBe("function");
    expect(typeof syncHandle.close).toBe("function");

    // Cleanup
    syncHandle.close();
  });

  // ─── Test 5: read_chunk_from_sync_handle ─────────────────────
  it("should read a specific byte range from a SyncAccessHandle", async () => {
    // Given: a file with known content (bytes 0-255)
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    mockFileStore.set("chunk-test.ply", data);

    const fileHandle = createMockFileHandle("chunk-test.ply");
    const syncHandle = await requestSyncAccessHandle(fileHandle);

    // When: we read bytes 100-200 (length = 100)
    const chunk = readChunkFromHandle(syncHandle, 100, 100);

    // Then: we should get exactly those bytes
    expect(chunk).toBeInstanceOf(Uint8Array);
    expect(chunk.byteLength).toBe(100);
    expect(chunk[0]).toBe(100);  // first byte should be 100
    expect(chunk[99]).toBe(199); // last byte should be 199

    // Cleanup
    syncHandle.close();
  });

  // ─── Test 6: handle_cleanup ──────────────────────────────────
  it("should delete temporary files from OPFS", async () => {
    // Given: a file in OPFS
    mockFileStore.set("temp.ply", new Uint8Array([1, 2, 3]));
    const root = createMockDirectoryHandle();

    // Verify it exists
    expect(mockFileStore.has("temp.ply")).toBe(true);

    // When: we delete it
    await deleteOpfsFile(root, "temp.ply");

    // Then: it should be gone
    expect(mockFileStore.has("temp.ply")).toBe(false);
  });
});
