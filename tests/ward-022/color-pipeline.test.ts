/**
 * Ward 022 — Color Ramp Mapping tests (CPU-side).
 *
 * GPU-output (lineær sampling, fragment shader textureSample) verificeres KUN
 * manuelt via V1-V4. CPU-tests her dækker:
 *   - Ramp data sanity (T1, T4, T6)
 *   - Normalization helper (T2)
 *   - Uniform byte layout (T3)
 *   - Bind group layout (T5)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VIRIDIS_RAMP,
  CLASS_PALETTE,
  ColorModeUniform,
  MODE_INTENSITY,
  normalizeIntensity,
  repackRgbToRgba,
} from "../../src/webgpu/color-ramps.js";
import { compileColoredPointPipeline } from "../../src/webgpu/colored-point-pipeline.js";

vi.stubGlobal("GPUBufferUsage", {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
});
vi.stubGlobal("GPUShaderStage", { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 });
vi.stubGlobal("GPUTextureUsage", {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
});

// ─── Mock infrastructure ────────────────────────────────────────

interface CapturedBindGroupLayout {
  label?: string;
  entries: {
    binding: number;
    visibility: number;
    buffer?: { type?: string };
    texture?: { sampleType?: string };
    sampler?: { type?: string };
  }[];
}

let capturedBgls: CapturedBindGroupLayout[] = [];

function createMockDevice(): GPUDevice {
  return {
    createShaderModule: vi.fn((d: { code: string }) => ({
      code: d.code,
      getCompilationInfo: async () => ({ messages: [] }),
    })),
    createRenderPipeline: vi.fn((d: { label?: string }) => ({
      label: d.label ?? "mock",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-bgl" })),
    })),
    createBindGroupLayout: vi.fn((d: CapturedBindGroupLayout) => {
      capturedBgls.push(d);
      return { label: d.label ?? "bgl" };
    }),
    createPipelineLayout: vi.fn(() => ({ label: "pl" })),
    createBuffer: vi.fn(() => ({ size: 0, usage: 0, destroy: vi.fn() })),
    createTexture: vi.fn(() => ({
      createView: vi.fn(() => ({ label: "view" })),
      destroy: vi.fn(),
    })),
    createSampler: vi.fn(() => ({ label: "sampler" })),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Ward 022: Color Ramp Mapping", () => {
  beforeEach(() => { capturedBgls = []; });

  // ─── T1: viridis_ramp_has_256_entries_rgba8 ───────────────────

  it("T1: Given: VIRIDIS_RAMP — When: vi inspicerer — Then: 1024 bytes med non-trivial colormap-data", () => {
    expect(VIRIDIS_RAMP).toBeInstanceOf(Uint8Array);
    expect(VIRIDIS_RAMP.length).toBe(1024);
    // Stub-Uint8Array er all-zero — Gold-impl SKAL have faktisk colormap data
    expect(VIRIDIS_RAMP.some(v => v !== 0)).toBe(true);
    // Alpha-kanal skal være 255 for hele ramp'en
    for (let i = 3; i < VIRIDIS_RAMP.length; i += 4) {
      expect(VIRIDIS_RAMP[i]).toBe(255);
    }
  });

  // ─── T2: normalize_intensity_clamps_outliers ──────────────────

  it("T2: Given: normalizeIntensity helper — When: input < min / > max / midt — Then: 0.0 / 1.0 / 0.5", () => {
    // Lav range: 100-200
    expect(normalizeIntensity(50, 100, 200)).toBe(0.0);   // under
    expect(normalizeIntensity(100, 100, 200)).toBe(0.0);  // grænse
    expect(normalizeIntensity(150, 100, 200)).toBe(0.5);  // midpunkt
    expect(normalizeIntensity(200, 100, 200)).toBe(1.0);  // grænse
    expect(normalizeIntensity(300, 100, 200)).toBe(1.0);  // over
  });

  // ─── T3: color_mode_uniform_serializes_to_correct_byte_layout ─

  it("T3: Given: ColorModeUniform(min=0.5, max=10.5, mode=INTENSITY) — When: serialiseres — Then: byte layout matcher std140", () => {
    const uniform = new ColorModeUniform(0.5, 10.5, MODE_INTENSITY);
    const buf = uniform.toArrayBuffer();
    expect(buf.byteLength).toBe(16); // 3 × 4 bytes + 4 byte padding

    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    expect(f32[0]).toBeCloseTo(0.5);   // min @ offset 0
    expect(f32[1]).toBeCloseTo(10.5);  // max @ offset 4
    expect(u32[2]).toBe(0);             // mode @ offset 8 (INTENSITY = 0)
    // u32[3] er padding — ignoreres
  });

  // ─── T4: classification_palette_has_32_entries_rgba8 ──────────

  it("T4: Given: CLASS_PALETTE — When: inspiceret — Then: 128 bytes med non-trivial paletværdier", () => {
    expect(CLASS_PALETTE).toBeInstanceOf(Uint8Array);
    expect(CLASS_PALETTE.length).toBe(128);
    expect(CLASS_PALETTE.some(v => v !== 0)).toBe(true);
    // Klasse 2 = Ground (brun: høj R, mellem G, lav B)
    const r = CLASS_PALETTE[2 * 4 + 0]!;
    const g = CLASS_PALETTE[2 * 4 + 1]!;
    const b = CLASS_PALETTE[2 * 4 + 2]!;
    expect(r).toBeGreaterThan(b); // brun-like
    // Klasse 9 = Water (blå: lav R, mellem-høj G, høj B)
    const wB = CLASS_PALETTE[9 * 4 + 2]!;
    const wR = CLASS_PALETTE[9 * 4 + 0]!;
    expect(wB).toBeGreaterThan(wR); // blå-like
  });

  // ─── T5: colored_pipeline_bind_group_layout_has_correct_bindings

  it("T5: Given: compileColoredPointPipeline — When: pipeline kompileres — Then: bind group layout har 7 specifikke bindings", async () => {
    const device = createMockDevice();
    await compileColoredPointPipeline(device, "bgra8unorm");

    expect(capturedBgls.length).toBeGreaterThanOrEqual(1);
    const bgl = capturedBgls[0]!;
    expect(bgl.entries.length).toBe(7);

    // Binding 0-3: positions, intensity, rgb, classification (alle read-only-storage, VERTEX)
    for (let i = 0; i < 4; i++) {
      const e = bgl.entries.find(x => x.binding === i);
      expect(e, `binding ${i} mangler`).toBeDefined();
      expect(e!.buffer, `binding ${i} skal være buffer`).toBeDefined();
      expect(e!.buffer!.type, `binding ${i} skal være read-only-storage`).toBe("read-only-storage");
      expect(e!.visibility & GPUShaderStage.VERTEX, `binding ${i} VERTEX visibility`).toBeTruthy();
    }

    // Binding 4: texture (FRAGMENT)
    const tex = bgl.entries.find(x => x.binding === 4);
    expect(tex?.texture).toBeDefined();
    expect(tex!.visibility & GPUShaderStage.FRAGMENT).toBeTruthy();

    // Binding 5: sampler (FRAGMENT)
    const sampler = bgl.entries.find(x => x.binding === 5);
    expect(sampler?.sampler).toBeDefined();
    expect(sampler!.visibility & GPUShaderStage.FRAGMENT).toBeTruthy();

    // Binding 6: uniform (VERTEX + FRAGMENT)
    const uni = bgl.entries.find(x => x.binding === 6);
    expect(uni?.buffer).toBeDefined();
    expect(uni!.buffer!.type).toBe("uniform");
    expect(uni!.visibility & GPUShaderStage.VERTEX).toBeTruthy();
    expect(uni!.visibility & GPUShaderStage.FRAGMENT).toBeTruthy();
  });

  // ─── T6: viridis_at_half_matches_matplotlib_reference ─────────

  it("T6: Given: VIRIDIS_RAMP[128] — When: sammenlignet med Matplotlib reference — Then: ±2/255 per kanal", () => {
    // Matplotlib's _viridis_data[128] = (0.127568, 0.566949, 0.550556)
    // Konvertering til u8 afhænger af round vs. floor:
    //   round: (33, 145, 140)
    //   floor: (32, 144, 140)
    // Begge er valide impl-valg. Vi tester midpunkt med ±2 tolerance for at
    // acceptere begge mens vi fanger ægte drift (fx forkert ramp-data).
    const REF_R = 33;
    const REF_G = 145;
    const REF_B = 140;
    const TOL = 2;
    const r = VIRIDIS_RAMP[128 * 4 + 0]!;
    const g = VIRIDIS_RAMP[128 * 4 + 1]!;
    const b = VIRIDIS_RAMP[128 * 4 + 2]!;
    const a = VIRIDIS_RAMP[128 * 4 + 3]!;

    expect(Math.abs(r - REF_R)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(g - REF_G)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b - REF_B)).toBeLessThanOrEqual(TOL);
    expect(a).toBe(255);
  });

  // ─── T7 (bonus): repackRgbToRgba inserts A=255 ────────────────

  it("T7: Given: 3-byte RGB buffer — When: re-pakkes til 4-byte RGBA — Then: A=255 indsat per point", () => {
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]); // 2 points
    const rgba = repackRgbToRgba(rgb);
    expect(rgba.length).toBe(8);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });
});
