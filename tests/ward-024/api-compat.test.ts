/**
 * Ward 024 — WebGPU API Migration & Tech Debt
 *
 * Verificerer at alle render-moduler følger samme `getCompilationInfo`-mønster
 * som Ward 20's `point-pipeline.ts`:
 *   1. Foretrækker nye API (`getCompilationInfo`) når den findes
 *   2. Falder tilbage til legacy (`compilationInfo`) når kun den findes
 *   3. Kaster en beskrivende fejl når INGEN af dem findes
 *
 * Tests T1-T9 er table-driven over fire moduler. T10 er blokeret af QA1 Open Question 1
 * (Ward 7 test-decision) og indgår ikke i denne fil.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { compileRenderPipeline } from "../../src/webgpu/render-pipeline.js";
import { compileSplatShader } from "../../src/webgpu/splat-shader.js";
import { createSortPipeline } from "../../src/webgpu/radix-sort-gpu.js";
import { createGlobalSortPipelines } from "../../src/webgpu/radix-sort-global.js";

// ─── WebGPU Constant Stubs ──────────────────────────────────────

vi.stubGlobal("GPUBufferUsage", {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
});
vi.stubGlobal("GPUShaderStage", { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 });

// ─── Mock Infrastructure ────────────────────────────────────────

// "new-only" eksisterer ikke som variant — det ville være semantisk lig "both"
// for nuværende tests og ville antyde falsk coverage. Tilføj kun hvis et fremtidigt
// test eksplicit kræver isolation af "modulet virker uden legacy".
type ApiVariant = "both" | "legacy-only" | "neither";

interface CompilationSpies {
  getCompilationInfo: ReturnType<typeof vi.fn>;
  legacyCompilationInfo: ReturnType<typeof vi.fn>;
}

function createMockDevice(variant: ApiVariant): {
  device: GPUDevice;
  spies: CompilationSpies;
} {
  const spies: CompilationSpies = {
    getCompilationInfo: vi.fn(async () => ({ messages: [] })),
    legacyCompilationInfo: vi.fn(async () => ({ messages: [] })),
  };

  const buildShaderModule = (desc: { code: string; label?: string }) => {
    const mod: Record<string, unknown> = {
      code: desc.code,
      label: desc.label ?? "mock-shader",
    };
    if (variant === "both") {
      mod.getCompilationInfo = spies.getCompilationInfo;
      mod.compilationInfo = spies.legacyCompilationInfo;
    } else if (variant === "legacy-only") {
      mod.compilationInfo = spies.legacyCompilationInfo;
    }
    // variant === "neither" → ingen API tilføjes
    return mod;
  };

  const device = {
    createShaderModule: vi.fn(buildShaderModule),
    createRenderPipeline: vi.fn((d: { label?: string }) => ({
      label: d.label ?? "mock-pipeline",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-bgl" })),
    })),
    createComputePipeline: vi.fn((d: { label?: string }) => ({
      label: d.label ?? "mock-cpipe",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-bgl" })),
    })),
    createComputePipelineAsync: vi.fn(async (d: { label?: string }) => ({
      label: d.label ?? "mock-cpipe",
      getBindGroupLayout: vi.fn(() => ({ label: "auto-bgl" })),
    })),
    createBindGroupLayout: vi.fn((d: { label?: string }) => ({ label: d.label ?? "bgl" })),
    createPipelineLayout: vi.fn(() => ({ label: "layout" })),
    createBindGroup: vi.fn(() => ({ label: "bg" })),
    createBuffer: vi.fn(() => ({ size: 0, usage: 0, destroy: vi.fn() })),
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;

  return { device, spies };
}

// ─── Module Adapters ────────────────────────────────────────────

type ModuleCompiler = (device: GPUDevice) => Promise<unknown>;

const modules: { name: string; compile: ModuleCompiler }[] = [
  {
    name: "render-pipeline (Ward 5)",
    compile: (d) => compileRenderPipeline(d, "bgra8unorm"),
  },
  {
    name: "splat-shader (Ward 7)",
    compile: (d) => compileSplatShader(d, "bgra8unorm"),
  },
  {
    name: "radix-sort-gpu (Ward 6)",
    compile: (d) => createSortPipeline(d),
  },
  {
    name: "radix-sort-global (Ward 12)",
    compile: (d) => createGlobalSortPipelines(d),
  },
];

// ─── Tests ──────────────────────────────────────────────────────

describe("Ward 024: WebGPU API Migration", () => {
  beforeEach(() => {
    // Ryd evt. shared spy-state mellem tests (sikkerheds-net for fremtidige
    // tests der måtte introducere global spies)
    vi.clearAllMocks();
  });

  describe.each(modules)("$name", ({ compile }) => {
    // T1-T4: prefer new API when both present

    it("Given: device har begge API'er — When: pipeline kompileres — Then: kun getCompilationInfo kaldes", async () => {
      const { device, spies } = createMockDevice("both");
      await compile(device);
      expect(spies.getCompilationInfo).toHaveBeenCalled();
      expect(spies.legacyCompilationInfo).not.toHaveBeenCalled();
    });

    // T5-T8: fall back to legacy when new API missing

    it("Given: device har kun legacy compilationInfo — When: pipeline kompileres — Then: legacy kaldes", async () => {
      const { device, spies } = createMockDevice("legacy-only");
      await compile(device);
      expect(spies.legacyCompilationInfo).toHaveBeenCalled();
      expect(spies.getCompilationInfo).not.toHaveBeenCalled();
    });

    // T9: throws when neither present (strict pattern matching Ward 20's reference)

    it("Given: device har hverken API — When: pipeline kompileres — Then: kastes fejl der nævner 'neither' OG begge API-navne", async () => {
      const { device } = createMockDevice("neither");

      // Catch err for at kunne inspicere message med tre uafhængige assertions.
      // En enkelt regex med både "getCompilationInfo" og "compilationInfo" kræver
      // en svær lookbehind for at undgå at "getCompilationInfo" matcher begge —
      // derfor splittes assertion'erne for klarhed.
      let caught: unknown = null;
      try {
        await compile(device);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toMatch(/neither/i);
      expect(msg).toContain("getCompilationInfo");
      // Negativ lookbehind for "Get": kræver standalone "compilationInfo"
      expect(msg).toMatch(/(?<![A-Za-z])compilationInfo/);
    });
  });
});
