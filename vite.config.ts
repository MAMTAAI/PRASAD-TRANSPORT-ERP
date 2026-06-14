import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      
      // 👇 यहाँ हमने workbox की लिमिट बढ़ाकर 10 MB कर दी है ताकि बड़ी फाइल पर क्रैश ना हो 
      workbox: {
        maximumFileSizeToCacheInBytes: 10485760, 
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
});