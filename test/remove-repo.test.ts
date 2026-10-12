import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';
import type { Sandbox } from './helpers.ts';

let sandbox: Sandbox;

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    const repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('repo', () => {
    it('gives the main checkout of the removed worktree as repo, not the repository of the cwd', async () => {
      const other = await tmpRepo('kanda');
      const dir = path.join(sandbox.wtHome, 'worktrees', 'kanda', 'detached');
      await git(other.dir, 'worktree', 'add', '--quiet', '--detach', dir, 'main');
      await expect(run([dir, '--keep-tab'])).resolves.toStrictEqual({
        branch: null,
        branchDeleted: false,
        branchKept: null,
        closedBlocks: [],
        removed: dir,
        repo: other.dir,
        warnings: [],
      });
    });
  });
});
