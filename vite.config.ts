import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',

      workbox: {
        // Phase B: modules are code-split, so the old 10 MB single-chunk cap
        // is no longer needed. 5 MB still covers the pdf.js worker chunk.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },

      manifest: {
        name: 'PRASAD TRANSPORT ERP',
        short_name: 'PRASAD ERP',
        description: 'Logistics Management System',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          {
            src: '/vite.svg',
            sizes: '192x192',
            type: 'image/svg+xml'
          },
          {
            src: '/vite.svg',
            sizes: '512x512',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ],

  build: {
    // Keep heavy shared vendors in their own long-cacheable chunks so a code
    // change in one ERP module doesn't invalidate the framework/vendor cache.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('firebase')) return 'vendor-firebase';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-recharts';
            if (id.includes('quill')) return 'vendor-quill';
            if (id.includes('react')) return 'vendor-react';
          }
        },
      },
    },
  },
});
