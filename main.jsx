import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the API is served by the Express server (default port 10000).
// Override with VITE_API_PORT if you run the server on a different port.
const API_PORT = process.env.VITE_API_PORT || '10000';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${API_PORT}` }
  }
});
