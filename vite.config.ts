import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error plain JS helper shared with site/ and native/ (scripts/csp.mjs)
import { checkReleaseCsp, hardenCsp, withLocalRelays } from './scripts/csp.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Content policy of the built page (security review M-3, L-1; scripts/csp.mjs): after the one-file
 * build, script-src becomes the SHA-256 of the inlined script (no 'unsafe-inline') and the local test
 * relays are removed. `vite preview` (local only: e2e and lab tests) adds the local relays back when
 * it serves the page, so the release file itself never allows them.
 */
function contentPolicy(): Plugin {
  let outDir = 'dist';
  const pages = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : []);
  return {
    name: 'p2p-content-policy',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle(o) {
      const dir = o.dir ?? outDir;
      for (const f of pages(dir)) {
        const html = hardenCsp(readFileSync(join(dir, f), 'utf8'));
        checkReleaseCsp(html);
        writeFileSync(join(dir, f), html);
      }
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const file = join(outDir, decodeURIComponent(path === '/' ? '/index.html' : path));
        if (!file.startsWith(outDir) || !file.endsWith('.html') || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(withLocalRelays(readFileSync(file, 'utf8')));
      });
    },
  };
}

// One self-contained file: dist/p2p.html (all JS and CSS inlined, nothing fetched).
export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(`${pkg.version}+${new Date().toISOString().slice(0, 10)}`) },
  plugins: [viteSingleFile({ removeViteModuleLoader: true }), contentPolicy()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { input: 'p2p.html' },
  },
  preview: { host: '127.0.0.1', open: false },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
} as any);
