import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only talks to /api/*; in development Vite forwards it to the API (no CORS needed),
// in Docker nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
