import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { cloneDestination, defaultBranch, ghMust, ghRun, ghTry, listPullRequests, readOrigin } from '../src/github.ts';
import type { Sandbox } from './helpers.ts';
import { ghDefaultBranchFixture, ghFixture, ghLog, git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

let sandbox: Sandbox;

describe('github helpers', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(readOrigin, () => {
    it('gives the GitHub owner and name of a GitHub origin', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      await expect(readOrigin(repo.dir)).resolves.toStrictEqual({ github: { name: 'name', owner: 'owner' }, present: true });
    });

    it('gives a present origin without GitHub for a non-GitHub origin', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/owner/name.git');
      await expect(readOrigin(repo.dir)).resolves.toStrictEqual({ github: null, present: true });
    });

    it('gives present false and a null github without an origin remote', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'remove', 'origin');
      await expect(readOrigin(repo.dir)).resolves.toStrictEqual({ github: null, present: false });
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

  describe(ghTry, () => {
    it('gives the output of gh and no error', async () => {
      ghFixture(['api', 'user'], 'me\n');
      await expect(ghTry('api', 'user')).resolves.toStrictEqual({ error: null, stdout: 'me\n' });
      expect(ghLog()).toStrictEqual(['api user']);
    });

    it('gives the error of gh, without the white space around it, when gh fails', async () => {
      await expect(ghTry('api', 'user')).resolves.toStrictEqual({ error: 'fake gh: no fixture', stdout: '' });
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

  describe(cloneDestination, () => {
    const repoRef = { name: 'x', owner: 'me' };
    let cloneRoot: string;
    let dest: string;

    beforeEach(() => {
      cloneRoot = tempDir('clones');
      dest = path.join(cloneRoot, 'me', 'x');
      writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ cloneRoot }));
    });

    it('gives the clone path and a null state when nothing is at the path', async () => {
      await expect(cloneDestination(repoRef)).resolves.toStrictEqual({ root: dest, state: null });
    });

    it('gives the clone path and the clone state when the path holds a clone of the repository', async () => {
      mkdirSync(dest, { recursive: true });
      await git(dest, 'init', '--quiet');
      await git(dest, 'remote', 'add', 'origin', 'git@github.com:me/x.git');
      await expect(cloneDestination(repoRef)).resolves.toStrictEqual({ root: dest, state: 'clone' });
    });

    it('raises path_conflict when the path holds something else', async () => {
      mkdirSync(dest, { recursive: true });
      await expect(cloneDestination(repoRef)).rejects.toMatchObject({ code: 'path_conflict', extra: { path: dest } });
    });

    it('raises path_conflict when the path holds a checkout without a GitHub origin', async () => {
      mkdirSync(dest, { recursive: true });
      await git(dest, 'init', '--quiet');
      await git(dest, 'remote', 'add', 'origin', 'https://gitlab.com/me/x.git');
      await expect(cloneDestination(repoRef)).rejects.toMatchObject({ code: 'path_conflict', extra: { path: dest } });
    });
  });

  describe(defaultBranch, () => {
    it('reads origin/HEAD', async () => {
      const repo = await tmpRepo();
      await repo.pushBranch('trunk/next');
      await git(repo.dir, 'remote', 'set-head', 'origin', 'trunk/next');
      await expect(defaultBranch(repo.dir, { name: 'name', owner: 'owner' })).resolves.toBe('trunk/next');
      expect(existsSync(sandbox.ghLog)).toBeFalsy();
    });

    it('asks GitHub when origin/HEAD is unset', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      ghDefaultBranchFixture('owner/name', 'develop');
      await expect(defaultBranch(repo.dir, { name: 'name', owner: 'owner' })).resolves.toBe('develop');
    });

    it('raises gh_failed when GitHub does not answer', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      await expect(defaultBranch(repo.dir, { name: 'name', owner: 'owner' })).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });

    it('skips GitHub when github is null', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      ghDefaultBranchFixture('owner/name', 'develop');
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await expect(defaultBranch(repo.dir, null)).resolves.toBe('work');
      expect(existsSync(sandbox.ghLog)).toBeFalsy();
    });

    it('reads origin/HEAD offline', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await expect(defaultBranch(repo.dir, null)).resolves.toBe('main');
    });

    it('raises git_failed outside a repo', async () => {
      await expect(defaultBranch(tempDir('plain'), null)).rejects.toMatchObject({ code: 'git_failed' });
    });
  });
});
