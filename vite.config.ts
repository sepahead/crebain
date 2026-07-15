/// <reference types="vitest" />
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { productionVendorBoundaryPlugin } from './scripts/lib/production-vendor-boundary.mjs'

const ROOT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const DEVELOPMENT_ROSBRIDGE_MODULE = 'src/ros/ROSBridge.ts'
const PRODUCTION_ROSBRIDGE_MODULE = 'src/ros/ROSBridgeDisabled.ts'

function projectModuleId(moduleId: string): string | null {
  const withoutQuery = moduleId.split('?', 1)[0]
  if (!withoutQuery.startsWith(ROOT_DIRECTORY)) return null
  const projectRelative = relative(ROOT_DIRECTORY, withoutQuery).replaceAll('\\', '/')
  if (projectRelative.startsWith('../') || projectRelative.startsWith('node_modules/')) return null
  return projectRelative
}

function vendorModuleId(moduleId: string): string | null {
  const withoutQuery = moduleId.split('?', 1)[0]
  if (!withoutQuery.startsWith(ROOT_DIRECTORY)) return null
  const projectRelative = relative(ROOT_DIRECTORY, withoutQuery).replaceAll('\\', '/')
  if (!projectRelative.startsWith('node_modules/')) return null
  return projectRelative
}

function uniqueModuleIds(
  moduleIds: string[],
  classify: (moduleId: string) => string | null
): string[] {
  return [
    ...new Set(moduleIds.map(classify).filter((value): value is string => value !== null)),
  ].sort()
}

function authorityBoundaryManifestPlugin(mode: string): Plugin {
  let report: {
    schema_version: number
    build_mode: string
    development_module: string
    production_replacement: string
    chunks: Array<{
      file: string
      entry: boolean
      facade_module: string | null
      imports: string[]
      dynamic_imports: string[]
      project_modules: string[]
      vendor_modules: string[]
      sha256: string
    }>
  } | null = null
  return {
    name: 'crebain-production-authority-boundary',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.entries(bundle)
        .filter(
          (entry): entry is [string, Extract<(typeof entry)[1], { type: 'chunk' }>] =>
            entry[1].type === 'chunk'
        )
        .map(([fileName, chunk]) => ({
          file: fileName,
          entry: chunk.isEntry,
          facade_module: chunk.facadeModuleId ? projectModuleId(chunk.facadeModuleId) : null,
          imports: [...chunk.imports].sort(),
          dynamic_imports: [...chunk.dynamicImports].sort(),
          project_modules: uniqueModuleIds(Object.keys(chunk.modules), projectModuleId),
          vendor_modules: uniqueModuleIds(Object.keys(chunk.modules), vendorModuleId),
          sha256: createHash('sha256').update(chunk.code).digest('hex'),
        }))
        .sort((left, right) => left.file.localeCompare(right.file))
      const projectModules = new Set(chunks.flatMap((chunk) => chunk.project_modules))

      if (projectModules.has(DEVELOPMENT_ROSBRIDGE_MODULE)) {
        this.error(`Production bundle includes ${DEVELOPMENT_ROSBRIDGE_MODULE}`)
      }
      if (!projectModules.has(PRODUCTION_ROSBRIDGE_MODULE)) {
        this.error(`Production bundle is missing ${PRODUCTION_ROSBRIDGE_MODULE}`)
      }

      report = {
        schema_version: 2,
        build_mode: mode,
        development_module: DEVELOPMENT_ROSBRIDGE_MODULE,
        production_replacement: PRODUCTION_ROSBRIDGE_MODULE,
        chunks,
      }
      this.emitFile({
        type: 'asset',
        fileName: 'authority-boundary.json',
        source: `${JSON.stringify(report, null, 2)}\n`,
      })
    },
    writeBundle(options) {
      if (!report) this.error('Production authority report was not generated')
      const outputDirectory = resolve(ROOT_DIRECTORY, options.dir ?? 'dist')
      const finalized = {
        ...report,
        chunks: report.chunks.map((chunk) => ({
          ...chunk,
          sha256: createHash('sha256')
            .update(readFileSync(resolve(outputDirectory, chunk.file)))
            .digest('hex'),
        })),
      }
      writeFileSync(
        resolve(outputDirectory, 'authority-boundary.json'),
        `${JSON.stringify(finalized, null, 2)}\n`
      )
    },
  }
}

export default defineConfig(({ command, mode }) => ({
  plugins: [
    productionVendorBoundaryPlugin(ROOT_DIRECTORY),
    react(),
    authorityBoundaryManifestPlugin(mode),
  ],

  // The raw rosbridge WebSocket implementation exists only in the Vite
  // development/test profile. Production resolves the same import to a
  // network-free fail-closed implementation, so Rollup cannot include the
  // rosbridge client in a desktop product bundle.
  resolve: {
    alias: {
      '#renderer-rosbridge': fileURLToPath(
        new URL(
          command === 'serve' ? './src/ros/ROSBridge.ts' : './src/ros/ROSBridgeDisabled.ts',
          import.meta.url
        )
      ),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  build: {
    target: 'esnext',
    minify: 'esbuild',
    // Tauri's modern WebViews do not need Vite's fallback. The polyfill calls
    // fetch directly and would bypass the renderer's sole bounded adapter.
    modulePreload: { polyfill: false },
    // Emit dist/.vite/manifest.json so scripts/check-bundle-size.mjs can measure
    // the initial (eager) load and exclude the lazy Rapier chunk.
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
}))
