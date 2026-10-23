import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Builds a versioned service worker that precaches the complete application
 * shell (excluding optional OCR payloads, which are runtime-cached on demand).
 */
function offlineServiceWorker() {
  return {
    name: 'teleprompter-offline-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map') && file !== 'sw.js')
        .map((file) => `./${file.replace(/\\/g, '/')}`);

      const publicFiles = [];
      const walk = (dir, prefix = '') => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const relative = `${prefix}${entry.name}`;
          if (entry.isDirectory()) {
            if (['tesseract', 'tessdata'].includes(entry.name)) continue;
            walk(path.join(dir, entry.name), `${relative}/`);
          } else if (!/\.(map|psd)$/i.test(entry.name)) {
            publicFiles.push(`./${relative.replace(/\\/g, '/')}`);
          }
        }
      };
      walk(path.resolve('public'));

      const precache = [...new Set([
        './',
        './index.html',
        ...assets,
        ...publicFiles,
      ])];
      const version = crypto
        .createHash('sha256')
        .update(JSON.stringify(precache) + Date.now())
        .digest('hex')
        .slice(0, 12);

      const source = `/* Advanced Teleprompter Studio — generated service worker ${version} */
const VERSION = '${version}';
const SHELL_CACHE = 'atp-shell-' + VERSION;
const RUNTIME_CACHE = 'atp-runtime-' + VERSION;
const PRECACHE = ${JSON.stringify(precache, null, 2)};
const OPTIONAL_PREFIXES = ['./tesseract/', './tessdata/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch((error) => console.warn('Precache failed', error))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL_CACHE && !key.startsWith('atp-runtime-')).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(request)) || (await cache.match('./index.html')) || (await cache.match('./'));
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (OPTIONAL_PREFIXES.some((prefix) => url.pathname.includes(prefix.slice(1)))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.pathname.includes('/assets/') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
`;

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [tailwindcss(), offlineServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    testTimeout: 20000,
  },
});
