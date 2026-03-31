/**
 * Ward 001 — Feature Detection Tests
 *
 * Tests 1-4: Verify runtime detection of browser capabilities.
 * These tests mock browser APIs to simulate different environments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectWebGPU,
  detectOPFS,
  detectMemory64,
  detectCrossOriginIsolated,
  detectFeatures,
  type FeatureFlags,
} from "../../src/detection/feature-flags.js";

describe("Ward 001: Feature Detection", () => {
  // ─── Test 1: detect_webgpu_available ─────────────────────────
  describe("detectWebGPU", () => {
    it("should return true when navigator.gpu exists and adapter is available", async () => {
      // Given: a browser with WebGPU support
      const mockGPU = {
        requestAdapter: vi.fn().mockResolvedValue({ name: "Mock GPU" }),
      };
      vi.stubGlobal("navigator", { gpu: mockGPU });

      // When: we detect WebGPU
      const result = await detectWebGPU();

      // Then: it should be detected as available
      expect(result).toBe(true);
    });

    it("should return false when navigator.gpu is undefined", async () => {
      // Given: a browser without WebGPU
      vi.stubGlobal("navigator", {});

      // When: we detect WebGPU
      const result = await detectWebGPU();

      // Then: it should not be available
      expect(result).toBe(false);
    });

    it("should return false when requestAdapter returns null", async () => {
      // Given: WebGPU API exists but no adapter available
      const mockGPU = {
        requestAdapter: vi.fn().mockResolvedValue(null),
      };
      vi.stubGlobal("navigator", { gpu: mockGPU });

      // When: we detect WebGPU
      const result = await detectWebGPU();

      // Then: it should not be available (no usable GPU)
      expect(result).toBe(false);
    });
  });

  // ─── Test 2: detect_opfs_available ───────────────────────────
  describe("detectOPFS", () => {
    it("should return true when navigator.storage.getDirectory is available", async () => {
      // Given: a browser with OPFS support
      const mockStorage = {
        getDirectory: vi.fn().mockResolvedValue({}),
      };
      vi.stubGlobal("navigator", { storage: mockStorage });

      // When: we detect OPFS
      const result = await detectOPFS();

      // Then: OPFS should be available
      expect(result).toBe(true);
    });

    it("should return false when navigator.storage is undefined", async () => {
      // Given: a browser without Storage API
      vi.stubGlobal("navigator", {});

      // When: we detect OPFS
      const result = await detectOPFS();

      // Then: OPFS should not be available
      expect(result).toBe(false);
    });

    it("should return false when getDirectory throws", async () => {
      // Given: OPFS API exists but is broken/blocked
      const mockStorage = {
        getDirectory: vi.fn().mockRejectedValue(new Error("SecurityError")),
      };
      vi.stubGlobal("navigator", { storage: mockStorage });

      // When: we detect OPFS
      const result = await detectOPFS();

      // Then: OPFS should not be available
      expect(result).toBe(false);
    });
  });

  // ─── Test 3: detect_memory64_support ─────────────────────────
  describe("detectMemory64", () => {
    it("should return a boolean indicating memory64 support", async () => {
      // Given: any browser environment
      // (memory64 detection compiles a probe Wasm module)

      // When: we detect memory64
      const result = await detectMemory64();

      // Then: it should return a boolean (true or false depending on runtime)
      expect(typeof result).toBe("boolean");
    });

    it("should return false when WebAssembly.validate is not available", async () => {
      // Given: an environment without WebAssembly.validate
      const origValidate = WebAssembly.validate;
      vi.stubGlobal("WebAssembly", {
        ...WebAssembly,
        validate: undefined,
      });

      // When: we detect memory64
      const result = await detectMemory64();

      // Then: it should gracefully return false
      expect(result).toBe(false);

      // Cleanup
      vi.stubGlobal("WebAssembly", { ...WebAssembly, validate: origValidate });
    });
  });

  // ─── Test 4: detect_cross_origin_isolated ────────────────────
  describe("detectCrossOriginIsolated", () => {
    it("should return true when crossOriginIsolated is true", () => {
      // Given: a cross-origin isolated context (COOP + COEP headers set)
      vi.stubGlobal("crossOriginIsolated", true);

      // When: we check isolation status
      const result = detectCrossOriginIsolated();

      // Then: it should be true
      expect(result).toBe(true);
    });

    it("should return false when crossOriginIsolated is false", () => {
      // Given: a non-isolated context
      vi.stubGlobal("crossOriginIsolated", false);

      // When: we check isolation status
      const result = detectCrossOriginIsolated();

      // Then: it should be false
      expect(result).toBe(false);
    });

    it("should return false when crossOriginIsolated is undefined", () => {
      // Given: an older browser without the property
      vi.stubGlobal("crossOriginIsolated", undefined);

      // When: we check isolation status
      const result = detectCrossOriginIsolated();

      // Then: it should default to false
      expect(result).toBe(false);
    });
  });

  // ─── Test 5 (partial): detectFeatures aggregation ────────────
  describe("detectFeatures", () => {
    it("should return a complete FeatureFlags object with all fields", async () => {
      // Given: a mock browser environment
      vi.stubGlobal("navigator", {
        gpu: { requestAdapter: vi.fn().mockResolvedValue({ name: "GPU" }) },
        storage: { getDirectory: vi.fn().mockResolvedValue({}) },
      });
      vi.stubGlobal("crossOriginIsolated", true);

      // When: we detect all features
      const flags = await detectFeatures();

      // Then: all fields should be present and boolean
      expect(flags).toHaveProperty("webgpu");
      expect(flags).toHaveProperty("opfs");
      expect(flags).toHaveProperty("memory64");
      expect(flags).toHaveProperty("sharedArrayBuffer");
      expect(flags).toHaveProperty("crossOriginIsolated");

      expect(typeof flags.webgpu).toBe("boolean");
      expect(typeof flags.opfs).toBe("boolean");
      expect(typeof flags.memory64).toBe("boolean");
      expect(typeof flags.sharedArrayBuffer).toBe("boolean");
      expect(typeof flags.crossOriginIsolated).toBe("boolean");
    });
  });
});
