import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { defaultBranch, ghMust, ghRun, listPullRequests, nameWithOwner, originRepo } from '../src/github.ts';
import type { Sandbox } from './helpers.ts';
import { ghDefaultBranchFixture, ghFixture, ghLog, git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

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

  describe(ghRun, () => {
    it('gives the output of gh', async () => {
      ghFixture(['api', 'user'], 'me\n');
      await expect(ghRun('api', 'user')).resolves.toStrictEqual({ status: 0, stderr: '', stdout: 'me\n' });
      expect(ghLog()).toStrictEqual(['api user']);
    });

    it('gives the status and error of gh when it fails', async () => {
      await expect(ghRun('api', 'user')).resolves.toMatchObject({ status: 1, stderr: 'fake gh: no fixture\n' });
    });
  });

  describe(ghMust, () => {
    it('gives the output of gh', async () => {
      ghFixture(['api', 'user'], 'me\n');
      await expect(ghMust('api', 'user')).resolves.toBe('me\n');
    });

    it('raises gh_failed when gh fails', async () => {
      await expect(ghMust('api', 'user')).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });
  });

  describe(listPullRequests, () => {
    const repoRef = { name: 'name', owner: 'owner' };

    it('lists the pull requests that the filters select, with the fields', async () => {
      ghFixture(['pr', 'list', '--repo', 'owner/name', '--state', 'open', '--json', 'number,title'], '[{"number":3,"title":"Fix"}]');
      await expect(listPullRequests(repoRef, ['--state', 'open'], ['number', 'title'])).resolves.toStrictEqual({ error: null, prs: [{ number: 3, title: 'Fix' }] });
    });

    it('gives the error of gh and no pull requests when gh fails', async () => {
      await expect(listPullRequests(repoRef, ['--state', 'open'], ['number'])).resolves.toStrictEqual({ error: 'fake gh: no fixture', prs: [] });
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
      ghDefaultBranchFixture('owner/name', 'develop');
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
      ghDefaultBranchFixture('owner/name', 'develop');
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
