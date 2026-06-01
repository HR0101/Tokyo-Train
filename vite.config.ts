import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 設定
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
});
