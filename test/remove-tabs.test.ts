import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, managedPath, ternLog, tmpRepo, useSandbox, writeTernLs, writeTernLsRaw } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

let repo: RepoFixture;

const addFeature = async (): Promise<string> => {
  const dir = managedPath('feature-x');
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

  describe('tabs', () => {
    it('leaves the tabs alone under --keep-tab', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      await expect(run([dir, '--keep-tab'])).resolves.toMatchObject({ closedBlocks: [], warnings: [] });
      expect(ternLog()).toStrictEqual([]);
    });

    it('removes the worktree when Tern cannot list the blocks', async () => {
      const dir = await addFeature();
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['tabs not closed: fake tern: ls failed'] });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('warns for each block that Tern cannot close', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'close');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['block 1 not closed: fake tern: close failed'] });
    });

    it('passes on other errors before it removes anything', async () => {
      const dir = await addFeature();
      writeTernLsRaw('{');
      await expect(run([dir])).rejects.toBeInstanceOf(SyntaxError);
      expect(existsSync(dir)).toBeTruthy();
    });

    it.each<{ flags: string[] }>([{ flags: [] }, { flags: ['--force'] }])('closes each tab after the worktree is gone, with $flags', async ({ flags }) => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_GONE', dir);
      await expect(run([dir, ...flags])).resolves.toMatchObject({ closedBlocks: [1], warnings: [] });
    });
  });
});
