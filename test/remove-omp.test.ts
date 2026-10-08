import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, ignoreGlobally, tempDir, tmpRepo, useOmp, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

const addFeature = async (dir = path.join(sandbox.wtHome, 'worktrees', 'aoyama', 'feature-x')): Promise<string> => {
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', dir, 'origin/feature/x');
  return dir;
};

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('ownership', () => {
    it('rejects a worktree under the root that is not <root>/<repo>/<slug>', async () => {
      const elsewhere = await addFeature(path.join(sandbox.wtHome, 'worktrees', 'maui', 'feature-x'));
      await expect(run([elsewhere, '--force'])).rejects.toMatchObject({
        code: 'not_managed',
        message: `${elsewhere} is not ${path.join(sandbox.wtHome, 'worktrees', 'aoyama', '<slug>')}`,
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

  describe('copies of the ignored files of the main checkout', () => {
    it('removes copies without --force, and stops on changed ones', async () => {
      await ignoreGlobally('.env', '*.pem');
      writeFileSync(path.join(repo.dir, '.env'), 'SECRET=1\n');
      writeFileSync(path.join(repo.dir, 'key.pem'), 'KEY-A\n');
      const dir = await addFeature();
      writeFileSync(path.join(dir, '.env'), 'SECRET=2\n');
      writeFileSync(path.join(dir, 'key.pem'), 'KEY-A\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { existing: dir, files: ['!! .env'] } });
      writeFileSync(path.join(dir, '.env'), 'SECRET=1 and more\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { files: ['!! .env'] } });
      writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/x', removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
      expect(readFileSync(path.join(repo.dir, '.env'), 'utf-8')).toBe('SECRET=1\n');
    });

    it('stops on an ignored symbolic link, and on a file that is a directory in the main checkout', async () => {
      await ignoreGlobally('.env', 'secrets');
      writeFileSync(path.join(repo.dir, '.env'), 'SECRET=1\n');
      mkdirSync(path.join(repo.dir, 'secrets'));
      const dir = await addFeature();
      symlinkSync(path.join(repo.dir, '.env'), path.join(dir, '.env'));
      writeFileSync(path.join(dir, 'secrets'), '');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { files: ['!! .env', '!! secrets'] } });
    });

    it('compares large files chunk by chunk, also when they differ only in the last chunk', async () => {
      await ignoreGlobally('*.bin');
      const chunk = 64 * 1024;
      const full = Buffer.alloc(chunk * 2, 7);
      const ragged = Buffer.alloc(chunk * 3 + 5, 9);
      writeFileSync(path.join(repo.dir, 'full.bin'), full);
      writeFileSync(path.join(repo.dir, 'ragged.bin'), ragged);
      const dir = await addFeature();
      writeFileSync(path.join(dir, 'full.bin'), full);
      const changed = Buffer.from(ragged);
      changed[changed.length - 1] = 0;
      writeFileSync(path.join(dir, 'ragged.bin'), changed);
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { files: ['!! ragged.bin'] } });
      writeFileSync(path.join(dir, 'ragged.bin'), ragged);
      await expect(run([dir])).resolves.toMatchObject({ removed: dir, warnings: [] });
    });
  });
});
