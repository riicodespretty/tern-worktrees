import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { defaultBranch, nameWithOwner, originRepo } from '../src/github.ts';
import type { Sandbox } from './helpers.ts';
import { ghDefaultBranch, git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

let sandbox: Sandbox;

describe('github helpers', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(nameWithOwner, () => {
    it('joins the owner and the name', () => {
      expect(nameWithOwner({ name: 'name', owner: 'owner' })).toBe('owner/name');
    });
  });

  describe(originRepo, () => {
    it.each([
      ['git@github.com:riicodespretty/tern-worktrees.git', 'riicodespretty', 'tern-worktrees'],
      ['git@github.com:owner/name', 'owner', 'name'],
      ['https://github.com/owner/name.git', 'owner', 'name'],
      ['https://github.com/owner/some.repo', 'owner', 'some.repo'],
    ])('parses %s', async (url, owner, name) => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-url', 'origin', url);
      await expect(originRepo(repo.dir)).resolves.toStrictEqual({ name, owner });
    });

    it.each(['https://gitlab.com/owner/name.git', 'https://github.com/owner/name/extra', 'xgit@github.com:owner/name', 'git@github.com:owner/name.git.bak/x'])(
      'gives null for %s',
      async url => {
        const repo = await tmpRepo();
        await git(repo.dir, 'remote', 'set-url', 'origin', url);
        await expect(originRepo(repo.dir)).resolves.toBeNull();
      },
    );

    it('gives null without an origin', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'remove', 'origin');
      await expect(originRepo(repo.dir)).resolves.toBeNull();
    });
  });

  describe(defaultBranch, () => {
    it('reads origin/HEAD', async () => {
      const repo = await tmpRepo();
      await repo.pushBranch('trunk/next');
      await git(repo.dir, 'remote', 'set-head', 'origin', 'trunk/next');
      await expect(defaultBranch(repo.dir)).resolves.toBe('trunk/next');
    });

    it('asks GitHub when origin/HEAD is unset', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      ghDefaultBranch('owner/name', 'develop');
      await expect(defaultBranch(repo.dir)).resolves.toBe('develop');
    });

    it('raises gh_failed when GitHub does not answer', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      await expect(defaultBranch(repo.dir)).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });

    it('skips GitHub offline and gives the current branch when origin/HEAD is unset', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      ghDefaultBranch('owner/name', 'develop');
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await expect(defaultBranch(repo.dir, { offline: true })).resolves.toBe('work');
      expect(existsSync(sandbox.ghLog)).toBeFalsy();
    });

    it('reads origin/HEAD offline', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await expect(defaultBranch(repo.dir, { offline: true })).resolves.toBe('main');
    });

    it('falls back to the current branch without a GitHub origin', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'remove', 'origin');
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await expect(defaultBranch(repo.dir)).resolves.toBe('work');
    });

    it('raises git_failed outside a repo', async () => {
      await expect(defaultBranch(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });
});
