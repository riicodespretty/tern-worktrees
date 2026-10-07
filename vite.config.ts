import { defineConfig } from 'vite-plus';
import oxfmtConfig from './oxfmt.config.ts';
import oxlintConfig from './oxlint.config.ts';

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
  staged: {
    '*': 'vp check --fix',
    '*.luau': 'stylua --respect-ignores',
    '*.{md,ts}': 'vale --minAlertLevel=error',
  },
});
