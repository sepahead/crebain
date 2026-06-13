/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    strictPort: true,
  },

  build: {
    target: 'esnext',
    minify: 'esbuild',
    // Emit dist/.vite/manifest.json so scripts/check-bundle-size.mjs can measure
    // the initial (eager) load and exclude lazy chunks (rapier, the worker).
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          spark: ['@sparkjsdev/spark'],
          rapier: ['@dimforge/rapier3d-compat'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },

  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 120_000,
    coverage: {
      // Istanbul (not v8): v8 coverage needs node:inspector, unimplemented in Bun.
      provider: 'istanbul',
      reporter: ['text', 'text-summary', 'json', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      // Regression ratchet: floors set just below the current baseline so coverage
      // cannot silently drop. Raise these as the 3D/UI surface gains tests.
      thresholds: {
        statements: 25,
        branches: 22,
        functions: 28,
        lines: 25,
      },
    },
  },
})
