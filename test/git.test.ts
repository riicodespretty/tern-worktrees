import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  changedFileCount,
  checkoutAt,
  dirtyFiles,
  fetchOrigin,
  gitMust,
  gitRun,
  gitSucceeds,
  isAncestor,
  repoRoot,
  requireCheckoutAt,
  requireRepoRoot,
  updateSubmodules,
  worktrees,
} from '../src/git.ts';
import { git, gitShim, tempDir, tmpRepo, useSandbox } from './helpers.ts';

const trackingRefs = async (dir: string): Promise<string> => await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone');

/** Makes the folder `dir` with a `.git` file that points to no git directory, and gives the path of that file. */
const brokenGitfile = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.git'), 'gitdir: ../nowhere\n');
  return path.join(dir, '.git');
};

/** Writes into the repository `dir` broken submodule `.git` files at `lib/a` and `lib/a/n`, a `.git` file at `not-a-path` that no `.gitmodules` names, a `valid` checkout, and a `.gitmodules` entry `missing` with no directory. Gives the paths of the two broken files. */
const brokenSubmodules = async (dir: string): Promise<string[]> => {
  const outer = brokenGitfile(path.join(dir, 'lib', 'a'));
  const inner = brokenGitfile(path.join(dir, 'lib', 'a', 'n'));
  brokenGitfile(path.join(dir, 'not-a-path'));
  writeFileSync(
    path.join(dir, '.gitmodules'),
    '[submodule "a"]\n\tpath = lib/a\n\turl = not-a-path\n[submodule "valid"]\n\tpath = valid\n[submodule "missing"]\n\tpath = missing\n',
  );
  writeFileSync(path.join(dir, 'lib', 'a', '.gitmodules'), '[submodule "n"]\n\tpath = n\n');
  await git(dir, 'init', '--quiet', '--separate-git-dir', path.join(tempDir('gitdirs'), 'valid'), path.join(dir, 'valid'));
  return [outer, inner];
};

describe('git helpers', () => {
  beforeEach(() => {
    useSandbox();
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

  describe(gitRun, () => {
    it('runs git in the directory and gives its status and output', async () => {
      const repo = await tmpRepo();
      await expect(gitRun(repo.dir, 'branch', '--show-current')).resolves.toStrictEqual({ status: 0, stderr: '', stdout: 'main\n' });
      await expect(gitRun(tempDir('plain'), 'rev-parse', '--git-dir')).resolves.toMatchObject({ status: 128 });
    });
  });

  describe(gitMust, () => {
    it('gives the output of git and raises git_failed when git fails', async () => {
      const repo = await tmpRepo();
      await expect(gitMust(repo.dir, 'branch', '--show-current')).resolves.toBe('main\n');
      await expect(gitMust(tempDir('plain'), 'rev-parse', '--git-dir')).rejects.toMatchObject({ code: 'git_failed' });
    });
  });

  describe(gitSucceeds, () => {
    it('tells if git exits with status 0', async () => {
      const repo = await tmpRepo();
      await expect(gitSucceeds(repo.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/main')).resolves.toBeTruthy();
      await expect(gitSucceeds(repo.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/missing')).resolves.toBeFalsy();
    });
  });

  describe(isAncestor, () => {
    it('tells if a commit is an ancestor of another commit', async () => {
      const repo = await tmpRepo();
      await git(repo.dir, 'switch', '--quiet', '-c', 'work');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'work');
      await expect(isAncestor(repo.dir, 'main', 'work')).resolves.toBeTruthy();
      await expect(isAncestor(repo.dir, 'work', 'main')).resolves.toBeFalsy();
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

  describe(checkoutAt, () => {
    it('gives main at the top of the main checkout and inside in its subdirectory and its .git', async () => {
      const repo = await tmpRepo();
      mkdirSync(path.join(repo.dir, 'sub'));
      await expect(Promise.all([checkoutAt(repo.dir), checkoutAt(path.join(repo.dir, 'sub')), checkoutAt(path.join(repo.dir, '.git'))])).resolves.toStrictEqual([
        { role: 'main', root: repo.dir },
        { role: 'inside', root: repo.dir },
        { role: 'inside', root: repo.dir },
      ]);
    });

    it('gives linked at the top of a linked worktree and through a symlink to it, and inside in its subdirectory', async () => {
      const repo = await tmpRepo();
      const linked = path.join(tempDir('wt'), 'linked');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'side', linked);
      mkdirSync(path.join(linked, 'sub'));
      const link = path.join(tempDir('links'), 'link');
      symlinkSync(linked, link);
      await expect(Promise.all([checkoutAt(linked), checkoutAt(link), checkoutAt(path.join(linked, 'sub'))])).resolves.toStrictEqual([
        { role: 'linked', root: repo.dir },
        { role: 'linked', root: repo.dir },
        { role: 'inside', root: repo.dir },
      ]);
    });

    it('gives null in a bare repository, a plain directory and a missing path', async () => {
      const repo = await tmpRepo();
      await expect(Promise.all([checkoutAt(repo.origin), checkoutAt(tempDir('plain')), checkoutAt('/nonexistent/dir')])).resolves.toStrictEqual([null, null, null]);
    });
  });

  describe(requireCheckoutAt, () => {
    it('gives the checkout', async () => {
      const repo = await tmpRepo();
      await expect(requireCheckoutAt(repo.dir)).resolves.toStrictEqual({ role: 'main', root: repo.dir });
    });

    it('throws not_a_repo outside a repo', async () => {
      const plain = tempDir('plain');
      await expect(requireCheckoutAt(plain)).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
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

  describe(changedFileCount, () => {
    it('counts the changed and untracked files with no error', async () => {
      const repo = await tmpRepo();
      writeFileSync(path.join(repo.dir, 'README.md'), 'changed\n');
      writeFileSync(path.join(repo.dir, 'new.txt'), 'new\n');
      await expect(changedFileCount(repo.dir)).resolves.toStrictEqual({ count: 2, error: null });
    });

    it('gives 0 and the git error outside a repo', async () => {
      await expect(changedFileCount(tempDir('plain'))).resolves.toStrictEqual({ count: 0, error: 'fatal: not a git repository (or any of the parent directories): .git' });
    });

    it('gives 0 when the count without the submodules fails too, also after git printed lines', async () => {
      const repo = await tmpRepo();
      await gitShim(`case " $* " in *" --ignore-submodules=none "*) echo 'status broke' >&2; exit 1;; *" --ignore-submodules=all "*) echo '?? partial'; exit 1;; esac`);
      await expect(changedFileCount(repo.dir)).resolves.toStrictEqual({ count: 0, error: 'status broke' });
    });
  });

  describe(updateSubmodules, () => {
    it('gives nothing and copies nothing without a .gitmodules file', async () => {
      const [root, worktree] = await Promise.all([tmpRepo('root'), tmpRepo('worktree')]);
      mkdirSync(path.join(root.dir, '.git', 'modules', 'x'), { recursive: true });
      await expect(updateSubmodules(root.dir, worktree.dir)).resolves.toStrictEqual([]);
      expect(existsSync(path.join(worktree.dir, '.git', 'modules'))).toBeFalsy();
    });

    it('copies the submodule git directories of the main checkout and removes the broken .git files at each depth', async () => {
      const [root, worktree] = await Promise.all([tmpRepo('root'), tmpRepo('worktree')]);
      mkdirSync(path.join(root.dir, '.git', 'modules', 'x'), { recursive: true });
      const [outer, inner] = await brokenSubmodules(worktree.dir);
      await expect(updateSubmodules(root.dir, worktree.dir)).resolves.toStrictEqual([]);
      expect(
        [outer, inner, path.join(worktree.dir, 'not-a-path', '.git'), path.join(worktree.dir, 'valid', '.git'), path.join(worktree.dir, '.git', 'modules', 'x')].map(file =>
          existsSync(file),
        ),
      ).toStrictEqual([false, false, true, true, true]);
    });

    it('warns and keeps the broken .git files when the main checkout has no submodule git directories to copy', async () => {
      const [root, worktree] = await Promise.all([tmpRepo('root'), tmpRepo('worktree')]);
      const broken = await brokenSubmodules(worktree.dir);
      await expect(updateSubmodules(root.dir, worktree.dir)).resolves.toStrictEqual([
        `submodule repair failed: ENOENT: no such file or directory, lstat '${path.join(root.dir, '.git', 'modules')}'`,
      ]);
      expect(broken.map(file => existsSync(file))).toStrictEqual([true, true]);
    });

    it('warns with the trimmed git error when submodule update fails', async () => {
      const repo = await tmpRepo();
      await gitShim(`case " $* " in *" submodule update "*) echo x >&2; exit 1;; esac`);
      await expect(updateSubmodules(repo.dir, repo.dir)).resolves.toStrictEqual(['submodule update failed: x']);
    });

    it('gives the repair warning before the update warning when both fail', async () => {
      const [root, worktree] = await Promise.all([tmpRepo('root'), tmpRepo('worktree')]);
      await brokenSubmodules(worktree.dir);
      await gitShim(`case " $* " in *" submodule update "*) echo x >&2; exit 1;; esac`);
      await expect(updateSubmodules(root.dir, worktree.dir)).resolves.toStrictEqual([
        `submodule repair failed: ENOENT: no such file or directory, lstat '${path.join(root.dir, '.git', 'modules')}'`,
        'submodule update failed: x',
      ]);
    });
  });
});
