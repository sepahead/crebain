import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'target/**',
      'src-tauri/**',
      'coverage/**',
      'public/**',
      // Workflow-DSL scripts (top-level await/return, not standalone modules).
      '.claude/**',
    ],
  },

  // Application sources: full type-aware linting
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      eslintConfigPrettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],

      // Production code must use the centralized logger (src/lib/logger.ts)
      'no-console': 'error',

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      'max-lines': ['error', { max: 1500, skipBlankLines: true, skipComments: true }],
    },
  },

  // The logger is the one sanctioned console user
  {
    files: ['src/lib/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // The viewer still combines the WebGL lifecycle and its tactical surface.
  // Keep this exception local so every other production module has a hard limit.
  {
    files: ['src/components/CrebainViewer.tsx'],
    rules: {
      'max-lines': 'off',
    },
  },

  // Tests and benchmarks: relax rules that conflict with test ergonomics
  {
    files: ['src/**/__tests__/**', 'src/**/*.{test,spec}.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-console': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Root-level config files: not part of the tsconfig project, no type-aware rules
  {
    files: ['*.config.{js,ts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, eslintConfigPrettier],
  }
)
