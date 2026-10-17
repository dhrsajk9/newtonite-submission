import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development (`npm run dev`), Vite serves the UI on :5173 and forwards
// /api calls to the API on :3000, so the browser sees a single origin.
// In Docker, the built files are served by the API itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
