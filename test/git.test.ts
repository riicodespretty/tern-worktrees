import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  defaultBranch,
  dirtyFiles,
  fetchOrigin,
  gitRun,
  hardToRebuild,
  hasOrigin,
  nameWithOwner,
  originRepo,
  repoRoot,
  requireRepoRoot,
  worktreeLosses,
  worktrees,
} from '../src/git.ts';
import type { Sandbox } from './helpers.ts';
import { ghFixture, git, ignoreGlobally, tempDir, tmpRepo, useSandbox } from './helpers.ts';

const VIEW_DEFAULT_BRANCH = ['repo', 'view', 'owner/name', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'];

let sandbox: Sandbox;
const trackingRefs = async (dir: string): Promise<string> => await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone');
const nestedSubmodules = async (): Promise<string> => {
  const inner = await tmpRepo('inner');
  const outer = await tmpRepo('outer');
  await git(outer.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(outer.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(outer.dir, 'push', '--quiet', 'origin', 'main');
  const repo = await tmpRepo();
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', outer.origin, 'outer');
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add outer');
  return repo.dir;
};

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

  describe(nameWithOwner, () => {
    it('joins the owner and the name', () => {
      expect(nameWithOwner({ name: 'name', owner: 'owner' })).toBe('owner/name');
    });
  });

  describe(gitRun, () => {
    it('runs git in the directory and gives its status and output', async () => {
      const repo = await tmpRepo();
      await expect(gitRun(repo.dir, 'branch', '--show-current')).resolves.toStrictEqual({ status: 0, stderr: '', stdout: 'main\n' });
      await expect(gitRun(tempDir('plain'), 'rev-parse', '--git-dir')).resolves.toMatchObject({ status: 128 });
    });
  });

  describe(requireRepoRoot, () => {
    it('gives the main checkout', async () => {
      const repo = await tmpRepo();
      await expect(requireRepoRoot(repo.dir)).resolves.toBe(repo.dir);
    });

    it('throws not_a_repo outside a repo', async () => {
      const plain = tempDir('plain');
      await expect(requireRepoRoot(plain)).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
    });
  });

  describe(hasOrigin, () => {
    it('tells if the repo has an origin', async () => {
      const repo = await tmpRepo();
      await expect(hasOrigin(repo.dir)).resolves.toBeTruthy();
      await git(repo.dir, 'remote', 'remove', 'origin');
      await expect(hasOrigin(repo.dir)).resolves.toBeFalsy();
    });
  });

  describe(fetchOrigin, () => {
    it('fetches, and prunes the deleted branches of origin only when asked', async () => {
      const repo = await tmpRepo();
      await repo.pushBranch('gone');
      await git(repo.dir, 'fetch', '--quiet', 'origin');
      await git(repo.origin, 'branch', '--quiet', '-D', 'gone');
      await expect(fetchOrigin(repo.dir, false)).resolves.toBeNull();
      await expect(trackingRefs(repo.dir)).resolves.toBe('refs/remotes/origin/gone\n');
      await expect(fetchOrigin(repo.dir, true)).resolves.toBeNull();
      await expect(trackingRefs(repo.dir)).resolves.toBe('');
    });

    it.each([true, false])('gives a warning when the fetch fails with prune %j', async prune => {
      const repo = await tmpRepo();
      await git(repo.dir, 'remote', 'set-url', 'origin', path.join(tempDir('missing'), 'nope.git'));
      await expect(fetchOrigin(repo.dir, prune)).resolves.toMatch(/^fetch failed: .+/u);
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
      ghFixture(VIEW_DEFAULT_BRANCH, 'develop\n');
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
      ghFixture(VIEW_DEFAULT_BRANCH, 'develop\n');
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

  describe(worktrees, () => {
    it('lists the main checkout, a linked and a locked worktree', async () => {
      const repo = await tmpRepo();
      const base = tempDir('wt');
      const headLine = await git(repo.dir, 'rev-parse', 'HEAD');
      const head = headLine.trim();
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', path.join(base, 'a-linked'));
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', path.join(base, 'b-locked'));
      await git(repo.dir, 'worktree', 'lock', path.join(base, 'b-locked'));
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'kept', path.join(base, 'c kept'));
      await git(repo.dir, 'worktree', 'lock', '--reason', 'kept for review', path.join(base, 'c kept'));
      await expect(worktrees(repo.dir)).resolves.toStrictEqual([
        { branch: 'main', head, locked: null, main: true, path: repo.dir, prunable: false },
        { branch: 'feature/x', head, locked: null, main: false, path: path.join(base, 'a-linked'), prunable: false },
        { branch: null, head, locked: '', main: false, path: path.join(base, 'b-locked'), prunable: false },
        { branch: 'kept', head, locked: 'kept for review', main: false, path: path.join(base, 'c kept'), prunable: false },
      ]);
    });

    it('lists a bare repository without a HEAD', async () => {
      const repo = await tmpRepo();
      await expect(worktrees(repo.origin)).resolves.toStrictEqual([{ branch: null, head: '', locked: null, main: true, path: repo.origin, prunable: false }]);
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

    it('lists untracked files when status.showUntrackedFiles is no', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'config', 'status.showUntrackedFiles', 'no');
      mkdirSync(path.join(repo.dir, 'notes'));
      writeFileSync(path.join(repo.dir, 'notes', 'draft.txt'), 'x\n');
      await expect(dirtyFiles(repo.dir)).resolves.toStrictEqual(['?? notes/draft.txt']);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(dirtyFiles(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });

  describe(worktreeLosses, () => {
    it('finds nothing in a clean worktree with pushed submodules', async () => {
      const dir = await nestedSubmodules();
      await expect(worktreeLosses(dir)).resolves.toStrictEqual([]);
    });

    it('lists unpushed commits and dirty files at every submodule depth, and no ignored file', async () => {
      const dir = await nestedSubmodules();
      const outer = path.join(dir, 'outer');
      const nested = path.join(outer, 'inner');
      await git(nested, 'switch', '--quiet', '-c', 'work');
      await git(nested, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      const local = await git(nested, 'rev-parse', '--short', 'work');
      await git(nested, 'switch', '--quiet', '--detach', 'HEAD~1');
      writeFileSync(path.join(outer, 'new.txt'), 'x\n');
      await ignoreGlobally('secret.env');
      writeFileSync(path.join(outer, 'secret.env'), 'x\n');
      await expect(worktreeLosses(dir)).resolves.toStrictEqual([' M outer', 'outer: ?? new.txt', `outer/inner: unpushed ${local.trim()}`]);
    });

    it('lists the commit of a detached submodule HEAD that no remote holds', async () => {
      const dir = await nestedSubmodules();
      const outer = path.join(dir, 'outer');
      await git(outer, 'commit', '--quiet', '--allow-empty', '-m', 'detached work');
      const head = await git(outer, 'rev-parse', '--short', 'HEAD');
      await expect(worktreeLosses(dir)).resolves.toStrictEqual([' M outer', `outer: unpushed ${head.trim()}`]);
    });

    it('raises git_failed when it cannot list the submodules', async () => {
      const dir = await nestedSubmodules();
      writeFileSync(path.join(dir, '.gitmodules'), '[submodule "outer"\n');
      const failure = worktreeLosses(dir);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/bad config line/u);
    });

    it('raises git_failed when it cannot read the commits of a submodule', async () => {
      const dir = await nestedSubmodules();
      await git(path.join(dir, 'outer'), 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
      const failure = worktreeLosses(dir);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/unknown revision/u);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(worktreeLosses(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });

  describe(hardToRebuild, () => {
    it('lists each ignored file outside the rebuildable dirs, in submodules at every depth too', async () => {
      const dir = await nestedSubmodules();
      await ignoreGlobally(
        '.env*',
        '*.pem',
        'local.settings.json',
        'secrets/',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.DS_Store',
        '.cache',
        '.next',
        '.nuxt',
        '.output',
        '.turbo',
      );
      const rebuildable = [
        'node_modules/x/index.js',
        'dist/app.js',
        'build/a',
        'coverage/lcov.info',
        'src/.DS_Store',
        '.cache/c',
        '.next/n',
        '.nuxt/n',
        '.output/o',
        '.turbo/t',
        'outer/build/out.o',
        'outer/inner/.cache/c',
      ];
      const files = ['.env', 'secrets/a.pem', 'secrets/deep/b.txt', 'outer/.env.local', 'outer/inner/local.settings.json', ...rebuildable];
      for (const file of files) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), 'x\n');
      }
      symlinkSync('missing', path.join(dir, '.env.link'));
      const found = await hardToRebuild(dir);
      expect(found.toSorted()).toStrictEqual(['.env', '.env.link', 'outer/.env.local', 'outer/inner/local.settings.json', 'secrets/a.pem', 'secrets/deep/b.txt']);
    });

    it('finds nothing without ignored files', async () => {
      const repo = await tmpRepo();
      await expect(hardToRebuild(repo.dir)).resolves.toStrictEqual([]);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(hardToRebuild(tempDir('plain'))).rejects.toMatchObject({ code: 'git_failed' });
    });
  });
});
