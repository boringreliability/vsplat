/**
 * Ward 018 — First Light: Automated Sanity Tests
 *
 * These tests verify build artifacts, configuration, and entry points.
 * They do NOT test visual rendering — that requires manual browser verification
 * (V1-V8 in the ward spec).
 *
 * A1: wasm-pack build succeeds and produces expected files
 * A2: Vite config has COOP/COEP headers middleware
 * A3: main.ts exports a main() function
 * A4: DEPLOYMENT.md exists with required content
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";

const ROOT = resolve(__dirname, "../..");

describe("Ward 018: First Light — Build & Config Sanity", () => {

  // ─── A1: wasm_pack_build_succeeds ─────────────────────────────

  it("A1: wasm-pack build succeeds and produces pkg/ artifacts", () => {
    // Run wasm-pack build (no shell injection — execFileSync with args array)
    execFileSync(
      "wasm-pack",
      ["build", "crates/vsplat-core", "--target", "web", "--out-dir", "../../pkg"],
      { cwd: ROOT, timeout: 120_000, encoding: "utf-8", stdio: "pipe" },
    );

    // Verify output files exist
    expect(existsSync(resolve(ROOT, "pkg/vsplat_core.js"))).toBe(true);
    expect(existsSync(resolve(ROOT, "pkg/vsplat_core_bg.wasm"))).toBe(true);
    expect(existsSync(resolve(ROOT, "pkg/vsplat_core.d.ts"))).toBe(true);
  }, 120_000); // 2 minute timeout for wasm-pack

  // ─── A2: vite_config_has_coop_coep ────────────────────────────

  it("A2: Vite config includes COOP/COEP header middleware", () => {
    const configPath = resolve(ROOT, "vite.config.ts");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");

    // Must set both headers for crossOriginIsolated to be true
    expect(content).toContain("Cross-Origin-Opener-Policy");
    expect(content).toContain("Cross-Origin-Embedder-Policy");
    expect(content).toContain("same-origin");
    expect(content).toContain("require-corp");
  });

  // ─── A3: main_entry_exports ───────────────────────────────────

  it("A3: src/app/main.ts exists and exports main()", () => {
    const mainPath = resolve(ROOT, "src/app/main.ts");
    expect(existsSync(mainPath)).toBe(true);

    const content = readFileSync(mainPath, "utf-8");

    // Must export a main function
    expect(content).toMatch(/export\s+(async\s+)?function\s+main/);
  });

  // ─── A4: deployment_doc_exists ────────────────────────────────

  it("A4: DEPLOYMENT.md exists and mentions COOP, COEP, and Wasm MIME", () => {
    const docPath = resolve(ROOT, "DEPLOYMENT.md");
    expect(existsSync(docPath)).toBe(true);

    const content = readFileSync(docPath, "utf-8");

    expect(content).toMatch(/cross-origin-opener-policy/i);
    expect(content).toMatch(/cross-origin-embedder-policy/i);
    expect(content).toMatch(/application\/wasm/i);
  });
});
