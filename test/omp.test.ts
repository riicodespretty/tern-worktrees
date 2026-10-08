import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { findOmp, ompSettings, ompWorktreeAdd } from '../src/omp.ts';
import { FIXTURE_BIN, git, ompLog, tempDir, tmpRepo, useOmp, useSandbox } from './helpers.ts';

const FAKE_OMP = path.join(FIXTURE_BIN, 'omp');

/** Makes `TERN_WT_OMP` a script that runs the shell `body`. */
const scriptOmp = (body: string): string => {
  const file = path.join(tempDir('omp-script'), 'omp');
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  vi.stubEnv('TERN_WT_OMP', file);
  return file;
};

describe('omp', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(findOmp, () => {
    it('finds no omp in the sandbox', () => {
      expect(findOmp()).toBeNull();
    });

    it('prefers TERN_WT_OMP, then omp on PATH', () => {
      vi.stubEnv('TERN_WT_OMP', FAKE_OMP);
      expect(findOmp()).toBe(FAKE_OMP);
      vi.stubEnv('TERN_WT_OMP', '');
      const dir = tempDir('path');
      writeFileSync(path.join(dir, 'omp'), '#!/bin/sh\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${path.delimiter}${dir}${path.delimiter}${FIXTURE_BIN}`);
      expect(findOmp()).toBe(path.join(dir, 'omp'));
      vi.stubEnv('TERN_WT_OMP', undefined);
      expect(findOmp()).toBe(path.join(dir, 'omp'));
      vi.stubEnv('PATH', undefined);
      expect(findOmp()).toBeNull();
    });

    it('skips the relative dirs of PATH', () => {
      const dir = tempDir('relative-path');
      writeFileSync(path.join(dir, 'omp'), '#!/bin/sh\n', { mode: 0o755 });
      vi.stubEnv('TERN_WT_OMP', '');
      vi.stubEnv('PATH', path.relative(process.cwd(), dir));
      expect(findOmp()).toBeNull();
    });

    it('skips an omp that is a directory or not executable', () => {
      const dirs = [tempDir('omp-dir'), tempDir('omp-plain')];
      mkdirSync(path.join(dirs[0], 'omp'));
      writeFileSync(path.join(dirs[1], 'omp'), '#!/bin/sh\n', { mode: 0o644 });
      vi.stubEnv('TERN_WT_OMP', '');
      vi.stubEnv('PATH', dirs.join(path.delimiter));
      expect(findOmp()).toBeNull();
    });
  });

  describe(ompSettings, () => {
    it('reads worktree.base and worktree.clone in cwd', async () => {
      useOmp({ base: '/omp-base', clone: true });
      await expect(ompSettings('/')).resolves.toStrictEqual({ omp: FAKE_OMP, settings: { base: '/omp-base', clone: true }, warning: null });
      const project = tempDir('project');
      writeFileSync(path.join(project, '.fake-omp.json'), JSON.stringify({ 'worktree.clone': { value: false } }));
      await expect(ompSettings(project)).resolves.toStrictEqual({ omp: FAKE_OMP, settings: { base: null, clone: false }, warning: null });
      expect(ompLog()).toStrictEqual(['config list --json', 'config list --json']);
    });

    it('reads a setting without a value, or with a value of another type, as unset', async () => {
      scriptOmp(`echo '{"worktree.base":{"value":3},"worktree.clone":"yes"}'`);
      await expect(ompSettings('/')).resolves.toMatchObject({ settings: { base: null, clone: false }, warning: null });
      scriptOmp(`echo '{"worktree.base":null,"worktree.clone":{"value":"true"}}'`);
      await expect(ompSettings('/')).resolves.toMatchObject({ settings: { base: null, clone: false }, warning: null });
      scriptOmp(`echo '{"worktree.base":{"value":"/b"},"worktree.clone":null}'`);
      await expect(ompSettings('/')).resolves.toMatchObject({ settings: { base: '/b', clone: false }, warning: null });
      scriptOmp(`echo '{}'`);
      await expect(ompSettings('/')).resolves.toMatchObject({ settings: { base: null, clone: false }, warning: null });
    });

    it('reads no omp as not installed, without a warning', async () => {
      await expect(ompSettings('/')).resolves.toStrictEqual({ omp: null, settings: null, warning: null });
    });

    it.each([
      ['echo "no config" >&2; exit 3', 'omp config list failed: no config'],
      ['exit 3', 'omp config list failed: exit 3'],
      ['echo "{"', 'omp config list printed no JSON object'],
      ['echo "[]"', 'omp config list printed no JSON object'],
      ['echo "null"', 'omp config list printed no JSON object'],
      ['echo "1"', 'omp config list printed no JSON object'],
    ])('reads omp that runs %j as failed: no settings, with a warning', async (body, warning) => {
      const omp = scriptOmp(body);
      await expect(ompSettings('/')).resolves.toStrictEqual({ omp, settings: null, warning });
    });
  });

  describe(ompWorktreeAdd, () => {
    it('adds the worktree and returns the lines of stderr as warnings', async () => {
      const repo = await tmpRepo('aoyama');
      const dest = path.join(tempDir('wt'), 'feature-x');
      vi.stubEnv('FAKE_OMP_WARN', '  clone failed; checked out instead  \n\n');
      await expect(ompWorktreeAdd(FAKE_OMP, repo.dir, ['-b', 'feature/x', dest, 'main'])).resolves.toStrictEqual(['omp: clone failed; checked out instead']);
      expect(ompLog()).toStrictEqual([`worktree add -q -C ${repo.dir} -b feature/x ${dest} main`]);
      await expect(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD')).resolves.toBe('feature/x\n');
    });

    it('throws git_failed with the stderr of omp, or its exit status', async () => {
      const failure = ompWorktreeAdd(FAKE_OMP, tempDir('plain'), ['/x', 'main']);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/not a git repository/u);
      const omp = scriptOmp('exit 4');
      await expect(ompWorktreeAdd(omp, '/', ['/x', 'main'])).rejects.toMatchObject({ code: 'git_failed', message: 'omp worktree add exited 4' });
    });
  });
});
