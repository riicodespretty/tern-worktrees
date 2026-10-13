import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, managedPath, tempDir, tmpRepo, useOmp, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

let repo: RepoFixture;

const addFeature = async (dir: string): Promise<string> => {
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', dir, 'origin/feature/x');
  return dir;
};

describe('remove command', () => {
  beforeEach(async () => {
    useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('ownership', () => {
    it('rejects a worktree under the root that is not <root>/<repo>/<slug>', async () => {
      const elsewhere = await addFeature(managedPath('feature-x', 'maui'));
      await expect(run([elsewhere, '--force'])).rejects.toMatchObject({
        code: 'not_managed',
        message: `${elsewhere} is not ${managedPath('<slug>')}`,
      });
      expect(existsSync(elsewhere)).toBeTruthy();
    });

    it('refuses omp-owned worktrees in the omp root and removes the tern-managed ones', async () => {
      const base = tempDir('omp-wt');
      useOmp({ base, clone: true });
      const ompOwned = [path.join(base, '7-abc1234'), path.join(base, 'segment', 'aoyama')];
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', ompOwned[0], 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'wt/1', ompOwned[1], 'origin/main');
      const refusals = await Promise.allSettled(ompOwned.map(async dir => await run([dir, '--force'])));
      expect(refusals).toMatchObject(
        ompOwned.map(dir => ({ reason: { code: 'not_managed', message: `${dir} is an omp-owned worktree, not ${path.join(base, 'aoyama', '<slug>')}` }, status: 'rejected' })),
      );
      expect(ompOwned.map(dir => existsSync(dir))).toStrictEqual([true, true]);
      const mine = await addFeature(path.join(base, 'aoyama', 'feature-x'));
      await expect(run([mine])).resolves.toMatchObject({ removed: mine, warnings: [] });
      expect(existsSync(mine)).toBeFalsy();
    });
  });
});
