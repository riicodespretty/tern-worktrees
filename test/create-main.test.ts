import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { cliJson, contract, currentBranch, ghPrView, git, managedPath, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

describe('create command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
  });

  describe('the branch of the main checkout', () => {
    it.each([[[]], [['--relocate']]])('opens the main checkout where it is and focuses its tab, with %j', async extra => {
      writeTernLs({ work: [repo.dir] });
      await expect(cliJson(['create', '--repo', repo.dir, '--branch', 'main', ...extra])).resolves.toStrictEqual(contract('create-main-checkout', { repo: repo.dir }));
      expect(ternLog()).toStrictEqual(['ls --json', 'focus 1 --json']);
      await expect(currentBranch(repo.dir)).resolves.toBe('main');
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(sandbox.wtHome);
    });

    it('opens a tab for the main checkout when no tab shows it, and none with --no-tab', async () => {
      writeTernLs({});
      await expect(run(['--repo', repo.dir, '--branch', 'main', '--no-tab'])).resolves.toMatchObject({ owner: 'main', path: repo.dir, tab: null });
      expect(ternLog()).toStrictEqual([]);
      await expect(run(['--repo', repo.dir, '--branch', 'main'])).resolves.toMatchObject({ owner: 'main', path: repo.dir, tab: { block: 42, opened: true, session: 'aoyama' } });
      expect(ternLog()).toStrictEqual(['ls --json', 'ls --json', `new session aoyama --cwd ${repo.dir} --json`, 'rename 42 main --json']);
    });

    it('opens the main checkout where it is for a same-repo pull request of its branch', async () => {
      await useGithubOrigin();
      ghPrView();
      await git(repo.dir, 'switch', '--quiet', '-c', 'feature/x');
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toStrictEqual({
        branch: 'feature/x',
        carried: [],
        owner: 'main',
        path: repo.dir,
        repo: repo.dir,
        setup: null,
        status: 'reused',
        tab: null,
        warnings: [],
      });
      expect(existsSync(managedPath('feature-x'))).toBeFalsy();
    });
  });
});
