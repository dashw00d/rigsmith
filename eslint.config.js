import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'workspace/**', '.work/**', 'blender/**', '**/*.svelte'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['server/**/*.ts', '*.config.{js,ts}'], languageOptions: { globals: globals.node } },
]
