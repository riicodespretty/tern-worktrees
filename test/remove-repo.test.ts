import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, managedPath, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

describe('remove command', () => {
  beforeEach(async () => {
    useSandbox();
    const repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('repo', () => {
    it('gives the main checkout of the removed worktree as repo, not the repository of the cwd', async () => {
      const other = await tmpRepo('kanda');
      const dir = managedPath('detached', 'kanda');
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
