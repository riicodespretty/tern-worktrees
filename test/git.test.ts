import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { defaultBranch, dirtyFiles, originSlug, repoRoot, worktrees } from '../src/git.ts';
import type { Sandbox } from './helpers.ts';
import { git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

let sandbox: Sandbox;

describe('git helpers', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(repoRoot, () => {
    it('gives the main checkout from the top, a subdir and a linked worktree', async () => {
      const repo = await tmpRepo();
      mkdirSync(path.join(repo.dir, 'sub'));
      const linked = path.join(tempDir('wt'), 'linked');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'side', linked);
      await expect(Promise.all([repoRoot(repo.dir), repoRoot(path.join(repo.dir, 'sub')), repoRoot(linked)])).resolves.toStrictEqual([repo.dir, repo.dir, repo.dir]);
    });

    it('gives null outside a repo and in a bare repo', async () => {
      const repo = await tmpRepo();
      await expect(Promise.all([repoRoot(tempDir('plain')), repoRoot('/nonexistent/dir'), repoRoot(repo.origin)])).resolves.toStrictEqual([null, null, null]);
    });
  });

  describe(originSlug, () => {
    it.each([
      ['git@github.com:riicodespretty/tern-worktrees.git', 'riicodespretty', 'tern-worktrees'],
      ['git@github.com:owner/name', 'owner', 'name'],
      ['https://github.com/owner/name.git', 'owner', 'name'],
      ['https://github.com/owner/some.repo', 'owner', 'some.repo'],
    ])('parses %s', async (url, owner, name) => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-url', 'origin', url);
      await expect(originSlug(repo.dir)).resolves.toStrictEqual({ name, owner });
    });

    it.each(['https://gitlab.com/owner/name.git', 'https://github.com/owner/name/extra', 'xgit@github.com:owner/name', 'git@github.com:owner/name.git.bak/x'])(
      'gives null for %s',
      async url => {
        const repo = await tmpRepo();
        await git(repo.dir, 'remote', 'set-url', 'origin', url);
        await expect(originSlug(repo.dir)).resolves.toBeNull();
      },
    );

    it('gives null without an origin', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'remove', 'origin');
      await expect(originSlug(repo.dir)).resolves.toBeNull();
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
      writeFileSync(path.join(sandbox.ghDir, 'repo_view_owner_name_--json_defaultBranchRef_--jq_.defaultBranchRef.name.json'), 'develop\n');
      await expect(defaultBranch(repo.dir)).resolves.toBe('develop');
    });

    it('raises gh_failed when GitHub does not answer', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:owner/name.git');
      await expect(defaultBranch(repo.dir)).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
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

  describe(worktrees, () => {
    it('lists the main checkout, a linked and a locked worktree', async () => {
      const repo = await tmpRepo();
      const base = tempDir('wt');
      const headLine = await git(repo.dir, 'rev-parse', 'HEAD');
      const head = headLine.trim();
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', path.join(base, 'a-linked'));
      await git(repo.dir, 'worktree', 'add', '--quiet', '--lock', '--detach', path.join(base, 'b-locked'));
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'kept', path.join(base, 'c kept'));
      await git(repo.dir, 'worktree', 'lock', '--reason', 'kept for review', path.join(base, 'c kept'));
      await expect(worktrees(repo.dir)).resolves.toStrictEqual([
        { branch: 'main', head, locked: false, main: true, path: repo.dir, prunable: false },
        { branch: 'feature/x', head, locked: false, main: false, path: path.join(base, 'a-linked'), prunable: false },
        { branch: null, head, locked: true, main: false, path: path.join(base, 'b-locked'), prunable: false },
        { branch: 'kept', head, locked: true, main: false, path: path.join(base, 'c kept'), prunable: false },
      ]);
    });

    it('lists a bare repository without a HEAD', async () => {
      const repo = await tmpRepo();
      await expect(worktrees(repo.origin)).resolves.toStrictEqual([{ branch: null, head: '', locked: false, main: true, path: repo.origin, prunable: false }]);
    });

    it('marks a worktree whose dir is gone as prunable', async () => {
      const repo = await tmpRepo();
      const linked = path.join(tempDir('wt'), 'linked');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'side', linked);
      rmSync(linked, { force: true, recursive: true });
      const list = await worktrees(repo.dir);
      expect(list.map(worktree => [worktree.branch, worktree.prunable])).toStrictEqual([
        ['main', false],
        ['side', true],
      ]);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(worktrees(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });

  describe(dirtyFiles, () => {
    it('lists changed and untracked files', async () => {
      const repo = await tmpRepo();
      await expect(dirtyFiles(repo.dir)).resolves.toStrictEqual([]);
      writeFileSync(path.join(repo.dir, 'README.md'), 'changed\n');
      writeFileSync(path.join(repo.dir, 'new.txt'), 'new\n');
      await expect(dirtyFiles(repo.dir)).resolves.toStrictEqual([' M README.md', '?? new.txt']);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(dirtyFiles(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });
});
