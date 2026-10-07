import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

export default defineConfig({
  ...ultracite,
  arrowParens: 'avoid',
  bracketSameLine: false,
  bracketSpacing: true,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), 'styles/**', 'types/**', 'CHANGELOG.md'],
  jsxSingleQuote: false,
  printWidth: 180,
  proseWrap: 'preserve',
  quoteProps: 'consistent',
  semi: true,
  singleQuote: true,
  sortImports: false,
  sortPackageJson: false,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
});
