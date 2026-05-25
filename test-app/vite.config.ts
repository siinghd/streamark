import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'streamark': path.resolve(__dirname, '../src'),
      'streamark/react': path.resolve(__dirname, '../src/react'),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
});
