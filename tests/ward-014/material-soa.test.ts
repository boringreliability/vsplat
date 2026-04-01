/**
 * Ward 014 — Unified SoA Material Core (TypeScript GPU Buffer Tests)
 *
 * Category B: GPU buffer creation and upload for SH coefficients and opacity.
 * Follows Ward 5's GpuSplatBuffer pattern with dirty-flag optimization.
 *
 * These tests verify buffer sizing, upload behavior, and dirty-flag semantics.
 * They do NOT verify render pipeline bind group wiring (integration scope).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGpuSHBuffer,
  uploadSHBuffer,
  type GpuSHBuffer,
} from "../../src/webgpu/sh-buffer.js";
import {
  createGpuOpacityBuffer,
  uploadOpacityBuffer,
  type GpuOpacityBuffer,
} from "../../src/webgpu/opacity-buffer.js";

// ─── WebGPU Stubs ────────────────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
});

// ─── Mock ────────────────────────────────────────────────────────

function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => ({
      size: desc.size, usage: desc.usage, label: desc.label ?? "",
    })),
    queue: {
      writeBuffer: vi.fn(),
    },
  } as unknown as GPUDevice;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Ward 014: Unified SoA Material Core — GPU Buffers", () => {
  let mockDevice: GPUDevice;

  beforeEach(() => {
    mockDevice = createMockGPUDevice();
  });

  // ─── B1: sh_buffer_created_correct_size ─────────────────────────

  it("B1: createGpuSHBuffer creates buffer of splatCount * shDim * 4 bytes", () => {
    const splatCount = 5_000_000;
    const shDim = 48;

    const shBuffer = createGpuSHBuffer(mockDevice, splatCount, shDim);

    const call = vi.mocked(mockDevice.createBuffer).mock.calls[0][0];
    expect(call.size).toBe(splatCount * shDim * 4);
    expect(call.usage & GPUBufferUsage.STORAGE).toBeTruthy();
    expect(call.usage & GPUBufferUsage.COPY_DST).toBeTruthy();
    expect(shBuffer.splatCount).toBe(splatCount);
    expect(shBuffer.shDim).toBe(shDim);
    expect(shBuffer.dirty).toBe(true);
  });

  // ─── B2: sh_buffer_upload_writes_data ───────────────────────────

  it("B2: uploadSHBuffer writes to correct buffer with correct data", () => {
    const shBuffer = createGpuSHBuffer(mockDevice, 100, 3);
    const data = new Float32Array(300);
    data[0] = 1.5;
    data[299] = 9.9;

    uploadSHBuffer(mockDevice, shBuffer, data);

    expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockDevice.queue.writeBuffer).mock.calls[0];
    expect(call[0]).toBe(shBuffer.buffer);
    expect(call[1]).toBe(0);
    const written = call[2] as Float32Array;
    expect(written.length).toBe(300);
    expect(written[0]).toBeCloseTo(1.5);
    expect(shBuffer.dirty).toBe(false);
  });

  // ─── B3: sh_buffer_dirty_flag_skips_reupload ────────────────────

  it("B3: second uploadSHBuffer without dirty reset is a no-op", () => {
    const shBuffer = createGpuSHBuffer(mockDevice, 100, 3);
    const data = new Float32Array(300);

    uploadSHBuffer(mockDevice, shBuffer, data);
    uploadSHBuffer(mockDevice, shBuffer, data);

    expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
  });

  // ─── B4: opacity_buffer_created_correct_size ────────────────────

  it("B4: createGpuOpacityBuffer creates buffer of splatCount * 4 bytes", () => {
    const splatCount = 5_000_000;

    const opBuffer = createGpuOpacityBuffer(mockDevice, splatCount);

    const call = vi.mocked(mockDevice.createBuffer).mock.calls[0][0];
    expect(call.size).toBe(splatCount * 4);
    expect(call.usage & GPUBufferUsage.STORAGE).toBeTruthy();
    expect(call.usage & GPUBufferUsage.COPY_DST).toBeTruthy();
    expect(opBuffer.splatCount).toBe(splatCount);
    expect(opBuffer.dirty).toBe(true);
  });

  // ─── B5: opacity_buffer_upload_writes_data ──────────────────────

  it("B5: uploadOpacityBuffer writes to correct buffer with correct data", () => {
    const opBuffer = createGpuOpacityBuffer(mockDevice, 100);
    const data = new Float32Array(100);
    data[0] = 0.75;
    data[99] = 0.25;

    uploadOpacityBuffer(mockDevice, opBuffer, data);

    expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockDevice.queue.writeBuffer).mock.calls[0];
    expect(call[0]).toBe(opBuffer.buffer);
    expect(call[1]).toBe(0);
    const written = call[2] as Float32Array;
    expect(written.length).toBe(100);
    expect(written[0]).toBeCloseTo(0.75);
    expect(opBuffer.dirty).toBe(false);
  });

  // ─── B6: invalid_splat_count_throws ─────────────────────────────

  it("B6: both createGpuSHBuffer and createGpuOpacityBuffer throw on invalid splatCount", () => {
    expect(() => createGpuSHBuffer(mockDevice, 0, 48)).toThrow(RangeError);
    expect(() => createGpuSHBuffer(mockDevice, -1, 48)).toThrow(RangeError);
    expect(() => createGpuSHBuffer(mockDevice, 1.5, 48)).toThrow(RangeError);

    expect(() => createGpuOpacityBuffer(mockDevice, 0)).toThrow(RangeError);
    expect(() => createGpuOpacityBuffer(mockDevice, -1)).toThrow(RangeError);
    expect(() => createGpuOpacityBuffer(mockDevice, 1.5)).toThrow(RangeError);
  });

  // ─── B7: sh_upload_length_mismatch_throws ───────────────────────

  it("B7: uploadSHBuffer throws on data length mismatch", () => {
    const shBuffer = createGpuSHBuffer(mockDevice, 100, 3);

    // Too short
    expect(() => uploadSHBuffer(mockDevice, shBuffer, new Float32Array(299)))
      .toThrow();
    // Too long
    expect(() => uploadSHBuffer(mockDevice, shBuffer, new Float32Array(301)))
      .toThrow();
  });

  // ─── B8: opacity_upload_length_mismatch_throws ──────────────────

  it("B8: uploadOpacityBuffer throws on data length mismatch", () => {
    const opBuffer = createGpuOpacityBuffer(mockDevice, 100);

    expect(() => uploadOpacityBuffer(mockDevice, opBuffer, new Float32Array(99)))
      .toThrow();
    expect(() => uploadOpacityBuffer(mockDevice, opBuffer, new Float32Array(101)))
      .toThrow();
  });
});
