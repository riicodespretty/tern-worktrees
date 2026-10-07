import { defineConfig } from 'oxlint';
import core from 'ultracite/oxlint/core';
import vitest from 'ultracite/oxlint/vitest';
import antiSlop from 'ultracite/oxlint/anti-slop';
import { jsPluginSettings, selectJsPlugins } from 'ultracite/oxlint/js-plugins';

const jsPlugins = selectJsPlugins(['github', 'sonarjs']);

export default defineConfig({
  categories: {
    correctness: 'warn',
    suspicious: 'warn',
  },
  extends: [core, vitest, antiSlop, jsPlugins],
  ignorePatterns: [...(core.ignorePatterns ?? []), 'styles/**', 'types/**', 'coverage/**', 'reports/**', '.stryker-tmp/**'],
  jsPlugins: [
    ...(jsPlugins.jsPlugins ?? []),
    { name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' },
    { name: 'jsdoc-js', specifier: 'eslint-plugin-jsdoc' },
    'eslint-plugin-tsdoc',
    'oxlint-plugin-complexity',
  ],
  overrides: [
    {
      files: ['**/*.test.ts'],
      plugins: ['vitest'],
      rules: vitest.overrides?.[0]?.rules ?? {},
    },
    {
      files: ['**/*.{unit,spec,test,e2e}.{ts,tsx}'],
      rules: {
        'vitest/consistent-test-filename': ['error', { pattern: String.raw`.*\.(unit|spec|test|e2e)\.[tj]sx?$` }],
      },
    },
  ],
  plugins: [...(core.plugins ?? []), 'vitest'],
  rules: {
    'complexity/complexity': ['error', { cognitive: 15, cyclomatic: 15, minLines: 0 }],
    'eslint/complexity': 'off',
    'eslint/max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: true }],
    'jsdoc-js/require-jsdoc': [
      'error',
      {
        publicOnly: true,
        require: {
          ArrowFunctionExpression: true,
          ClassDeclaration: true,
          FunctionDeclaration: true,
          FunctionExpression: true,
          MethodDefinition: true,
        },
      },
    ],
    'jsdoc/check-tag-names': 'off',
    'sonarjs/cognitive-complexity': 'off',
    'sonarjs/no-small-switch': 'error',
    'sonarjs/prefer-immediate-return': 'error',
    'tsdoc/syntax': 'error',
    'typescript/no-unsafe-type-assertion': 'off',
    'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
    'vite-plus/prefer-vite-plus-imports': 'error',
  },
  settings: jsPluginSettings,
});
