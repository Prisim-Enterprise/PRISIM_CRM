import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Sign-in and own-account endpoints → FastAPI auth service. Must come before '/api'.
      '/api/v1/auth': 'http://localhost:4100',
      // Everything else → NestJS API.
      '/api': 'http://localhost:4000',
    },
  },
});
