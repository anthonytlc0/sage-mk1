import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative by default; GitHub Pages builds pass `--base=/<repo>/`. Nothing below hard-codes '/': the manifest's
  // start_url and scope, the service worker's URL and scope, and the precache list all follow Vite's base.
  base: './',
  // Pre-bundled at server start: found later, on a page's first request, it would make Vite reload every open page.
  optimizeDeps: { include: ['fflate'] },
  plugins: [
    VitePWA({
      // A new version waits until the app has been closed: it never takes over in the middle of a set.
      registerType: 'prompt',
      injectRegister: 'auto',
      manifest: {
        name: 'Sage MK1',
        short_name: 'Sage MK1',
        description: 'A 5-track tabletop loop station for the browser.',
        // iPadOS ignores fullscreen and orientation, and falls back to standalone anyway.
        display: 'standalone',
        theme_color: '#0b0b0c',
        background_color: '#0b0b0c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The whole build, the AudioWorklet included, so the app powers on offline. The manifest and its icons are
        // added by the plugin itself; the Home Screen icon and the SVG are listed here.
        globPatterns: ['**/*.{js,css,html,svg}', 'icons/apple-touch-icon.png'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
