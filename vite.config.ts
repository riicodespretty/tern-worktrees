import { defineConfig } from 'vite-plus';
import oxfmtConfig from './oxfmt.config.ts';
import oxlintConfig from './oxlint.config.ts';

const gate = ['vp check', 'vp run check:luau', 'vp run test:luau', 'vp run lint:prose', 'vp test --coverage', 'vp run test.mutation'];

export default defineConfig({
  fmt: oxfmtConfig,
  lint: {
    ...oxlintConfig,
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
  },
  // eslint-disable-next-line sort-keys
  staged: {
    '*.luau': 'stylua --respect-ignores',
    '*.{md,ts}': 'vale --minAlertLevel=error',
    '*': ['vp check --fix', () => gate],
  },
});
