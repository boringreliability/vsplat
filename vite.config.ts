import { defineConfig } from "vite";

export default defineConfig({
  // Serve pkg/ directory (wasm-pack output) as static assets
  publicDir: "pkg",
  plugins: [
    {
      name: "coop-coep-headers",
      configureServer(server) {
        server.middlewares.use((_, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          next();
        });
      },
    },
  ],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
});
