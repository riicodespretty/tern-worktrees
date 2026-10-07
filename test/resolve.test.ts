import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/resolve.ts';
import { must } from '../src/proc.ts';
import { git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

describe('resolve command', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(run, () => {
    it('resolves a repo dir, a worktree dir and a plain dir', async () => {
      const repo = await tmpRepo('aoyama');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:virtusize/aoyama.git');
      const worktree = path.join(tempDir('wt'), 'feature-x');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', worktree);
      const local = await tmpRepo('local');
      const plain = tempDir('plain');
      await expect(run([repo.dir, worktree, plain, local.dir, repo.dir])).resolves.toStrictEqual({
        repos: [
          { dir: repo.dir, name: 'aoyama', owner: 'virtusize', root: repo.dir },
          { dir: worktree, name: 'aoyama', owner: 'virtusize', root: repo.dir },
          { dir: plain, name: null, owner: null, root: null },
          { dir: local.dir, name: 'local', owner: null, root: local.dir },
          { dir: repo.dir, name: 'aoyama', owner: 'virtusize', root: repo.dir },
        ],
      });
    });

    it('runs git once per distinct dir', async () => {
      const shimDir = tempDir('shim');
      const log = path.join(shimDir, 'git.log');
      const realGit = await must(['sh', '-c', 'command -v git'], 'git_failed');
      writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit.trim()}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      const plain = tempDir('plain');
      await run([plain, plain, plain]);
      expect(readFileSync(log).toString().trim().split('\n')).toHaveLength(1);
    });

    it('gives an empty list without dirs', async () => {
      await expect(run([])).resolves.toStrictEqual({ repos: [] });
    });

    it('rejects options', async () => {
      await expect(run(['--nope'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    });
  });
});
