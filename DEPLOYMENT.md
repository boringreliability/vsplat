# Deployment — vsplat.io

## Required HTTP Headers

vsplat requires `crossOriginIsolated` to be `true` in the browser for SharedArrayBuffer support (Worker ↔ Main thread memory sharing). This requires two HTTP headers on **every response** from the server:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `crossOriginIsolated` will be `false` and the application will show a warning (functional but without zero-copy optimization).

## Wasm MIME Type

The `.wasm` file **must** be served with content type `application/wasm`. If served as `application/octet-stream`, `WebAssembly.compileStreaming()` will fail and fall back to slower `WebAssembly.compile()`.

Most modern hosting platforms (Vercel, Cloudflare Pages, Netlify) serve `.wasm` files correctly. If using nginx or Apache, add:

**nginx:**
```
types {
    application/wasm wasm;
}
```

**Apache (.htaccess):**
```
AddType application/wasm .wasm
```

## Content Security Policy (CSP)

If the deployment enforces CSP, the following directives are required:

```
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self';
```

- `wasm-unsafe-eval` allows Wasm compilation via `WebAssembly.compile()`
- `worker-src 'self'` allows Worker instantiation from same-origin scripts

Do **NOT** use `unsafe-inline` or wildcard origins.

## Asset Caching

Wasm and JS bundles should include content hashes in their filenames (Vite does this by default in production builds). This ensures that deployments don't serve stale Wasm after updates.

If using a CDN or service worker, ensure that cache invalidation works correctly for `.wasm` files.

## Development Server

The Vite dev server (`npm run dev`) automatically sets COOP/COEP headers via the plugin in `vite.config.ts`. No additional configuration needed for local development.
