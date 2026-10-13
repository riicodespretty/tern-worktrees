import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { ghPrView, git, tempDir, tmpRepo, useGithubOrigin, useSandbox } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

const expectNoWorktree = async (): Promise<void> => {
  await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(sandbox.wtHome);
};

describe('create command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await useGithubOrigin();
  });

  describe('a same-repo pull request whose branch is neither local nor on origin', () => {
    it('reports the failed fetch, and adds no worktree', async () => {
      await git(repo.origin, 'branch', 'feature/late', 'main');
      await git(repo.dir, 'remote', 'set-url', 'origin', path.join(tempDir('gone'), 'missing.git'));
      ghPrView('feature/late');
      const failure = run(['--repo', repo.dir, '--pr', '7', '--no-tab']);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/^no branch feature\/late of pull request 7 locally or on origin; fetch failed: fatal: .*missing\.git/su);
      await expect(failure).rejects.not.toThrow(/--new/u);
      await expectNoWorktree();
    });

    it('reports that origin does not have the branch, and adds no worktree', async () => {
      ghPrView('feature/gone');
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({
        code: 'bad_args',
        message: 'branch feature/gone of pull request 7 is not on origin; it may have been deleted',
      });
      await expectNoWorktree();
    });
  });
});
