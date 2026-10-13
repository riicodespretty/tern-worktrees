import { constants, cpSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CliError, must, run } from './proc.ts';
import type { RunResult } from './proc.ts';

/** One entry of `git worktree list`. `locked` holds the text of the lock, empty when the lock has no text, or null when the worktree has no lock. */
export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  locked: string | null;
  prunable: boolean;
}

/** Runs `git -C <dir> <args>`, waits for it to exit, and returns its exit status, standard output and standard error. It does not throw when git fails. */
export const gitRun = async (dir: string, ...args: string[]): Promise<RunResult> => await run(['git', '-C', dir, ...args]);

/** Runs `git -C <dir> <args>` and returns its standard output. Throws `git_failed` when git exits with a status other than 0. */
export const gitMust = async (dir: string, ...args: string[]): Promise<string> => await must(['git', '-C', dir, ...args], 'git_failed');

/** Tells if `git -C <dir> <args>` exits with status 0. */
export const gitSucceeds = async (dir: string, ...args: string[]): Promise<boolean> => {
  const result = await gitRun(dir, ...args);
  return result.status === 0;
};

/** Tells if `commit` is an ancestor of `of` in the repository at `dir`, or the same commit. */
export const isAncestor = async (dir: string, commit: string, of: string): Promise<boolean> => await gitSucceeds(dir, 'merge-base', '--is-ancestor', commit, of);

const mainCheckoutOf = (commonDir: string): string | null => (commonDir.endsWith('/.git') ? path.dirname(commonDir) : null);

const commonDirArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

/** The main checkout of the repository that holds `dir`, or null when `dir` is not in a repository with a checkout. */
export const repoRoot = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, ...commonDirArgs);
  return mainCheckoutOf(result.stdout.trim());
};

/** Like {@link repoRoot}, but throws `not_a_repo` when `dir` is not in a repository with a checkout. */
export const requireRepoRoot = async (dir: string): Promise<string> => {
  const root = await repoRoot(dir);
  if (root === null) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return root;
};

/** The position of a directory in its repository. `main` is the top directory of the main checkout, `linked` is the top directory of a linked worktree, and `inside` is a different directory in the repository. */
export type CheckoutRole = 'main' | 'linked' | 'inside';

/** A directory in a repository with a checkout: `main` is the main checkout, as git reports it. */
export interface Checkout {
  main: string;
  role: CheckoutRole;
}

/** The checkout at `dir`, or null when `dir` is not in a repository with a checkout. It compares real paths. */
export const checkoutAt = async (dir: string): Promise<Checkout | null> => {
  const result = await gitRun(dir, ...commonDirArgs, '--show-toplevel');
  const [commonDir, topLevel] = result.stdout.split('\n');
  const main = mainCheckoutOf(commonDir);
  if (main === null) {
    return null;
  }
  const realDir = realpathSync(dir);
  if (topLevel !== realDir) {
    return { main, role: 'inside' };
  }
  return { main, role: main === realDir ? 'main' : 'linked' };
};

/** Like {@link checkoutAt}, but throws `not_a_repo` when `dir` is not in a repository with a checkout. */
export const requireCheckoutAt = async (dir: string): Promise<Checkout> => {
  const checkout = await checkoutAt(dir);
  if (checkout === null) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return checkout;
};

/** The branch checked out at `dir`, or null when `dir` has a detached `HEAD`. A tag of the same name does not change it. */
export const currentBranch = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, 'symbolic-ref', '-q', 'HEAD');
  const ref = result.stdout.trim();
  return ref === '' ? null : ref.slice('refs/heads/'.length);
};

/**
 * Fetches `origin` in the repository at `root`. When `prune` is true, it also removes the tracking branches of the branches that `origin` deleted.
 * Returns a warning that starts with `fetch failed:` when the fetch fails, else null.
 */
export const fetchOrigin = async (root: string, prune: boolean): Promise<string | null> => {
  const result = await gitRun(root, 'fetch', ...(prune ? ['--prune'] : []), 'origin');
  return result.status === 0 ? null : `fetch failed: ${result.stderr.trim()}`;
};

const parseWorktree = (record: string, index: number): Worktree => {
  const [first, ...fields] = record.split('\0');
  const worktree: Worktree = { branch: null, head: '', locked: null, main: index === 0, path: first.slice('worktree '.length), prunable: false };
  for (const field of fields) {
    const [key] = field.split(' ');
    const value = field.slice(key.length + 1);
    if (key === 'HEAD') {
      worktree.head = value;
    } else if (key === 'branch') {
      worktree.branch = value.slice('refs/heads/'.length);
    } else if (key === 'locked') {
      worktree.locked = value;
    } else if (key === 'prunable') {
      worktree.prunable = true;
    }
  }
  return worktree;
};

/** All worktrees of the repository at `root`, the main checkout first. */
export const worktrees = async (root: string): Promise<Worktree[]> => {
  const output = await gitMust(root, 'worktree', 'list', '--porcelain', '-z');
  return output
    .split('\0\0')
    .filter(record => record !== '')
    .map(parseWorktree);
};

const lines = (output: string): string[] => output.split('\n').filter(line => line !== '');

const statusArgs = (ignoreSubmodules: 'all' | 'none'): string[] => ['status', '--porcelain', '--untracked-files=all', `--ignore-submodules=${ignoreSubmodules}`];

/**
 * The `git status --porcelain` lines of the worktree at `dir`, submodule changes included. It lists each file that git does not track,
 * also when `status.showUntrackedFiles` hides them.
 */
export const dirtyFiles = async (dir: string): Promise<string[]> => lines(await gitMust(dir, ...statusArgs('none')));

/** The number of changed files of the worktree at `dir`, and `error`, the git error when git cannot count them, else null. */
export interface ChangedCount {
  count: number;
  error: string | null;
}

/**
 * Counts the files that {@link dirtyFiles} lists, without a throw. When git fails, for example on a submodule with a broken `.git` file,
 * `error` holds the git error and the count does not include the submodules. The count is 0 when that fails too.
 */
export const changedFileCount = async (dir: string): Promise<ChangedCount> => {
  const full = await gitRun(dir, ...statusArgs('none'));
  if (full.status === 0) {
    return { count: lines(full.stdout).length, error: null };
  }
  const outer = await gitRun(dir, ...statusArgs('all'));
  return { count: outer.status === 0 ? lines(outer.stdout).length : 0, error: full.stderr.trim() };
};

/** The submodule paths in the `.gitmodules` file of the folder `base`, relative to `base`. Git runs in `top`. */
const gitmodulesPaths = async (top: string, base: string): Promise<string[]> => {
  const result = await gitRun(top, 'config', '-z', '-f', path.join(base, '.gitmodules'), '--get-regexp', String.raw`^submodule\..*\.path$`);
  return result.stdout
    .split('\0')
    .filter(entry => entry !== '')
    .map(entry => entry.slice(entry.indexOf('\n') + 1));
};

const brokenGitfilesUnder = async (top: string, base: string): Promise<string[]> => {
  const subs = await gitmodulesPaths(top, base);
  const found = await Promise.all(
    subs.map(async sub => {
      const subDir = path.join(base, sub);
      const gitfile = path.join(subDir, '.git');
      const broken = lstatSync(gitfile, { throwIfNoEntry: false })?.isFile() === true && !(await gitSucceeds(subDir, 'rev-parse', '--git-dir'));
      return [...(broken ? [gitfile] : []), ...(await brokenGitfilesUnder(top, subDir))];
    }),
  );
  return found.flat();
};

/**
 * The `.git` files of the submodules of the worktree at `dir`, at each depth, that point to no git directory. It reads the submodule paths
 * from the `.gitmodules` files, so it also finds a submodule in a submodule with a broken `.git` file.
 */
const brokenSubmoduleGitfiles = async (dir: string): Promise<string[]> => await brokenGitfilesUnder(dir, dir);

/**
 * Repairs the submodule `.git` files that omp clone mode copied into the worktree at `dir`. This copies the submodule git directories of the
 * main checkout (`.git/modules`) into the git directory of the worktree, copy-on-write where the file system can. Then it removes each broken
 * `.git` file. When the copy fails, the `.git` files stay and a `submodule repair failed:` warning tells why.
 */
const repairClonedSubmodules = async (root: string, dir: string): Promise<string[]> => {
  const broken = await brokenSubmoduleGitfiles(dir);
  if (broken.length === 0) {
    return [];
  }
  try {
    const [from, to] = await Promise.all([root, dir].map(async checkout => await gitMust(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'modules')));
    cpSync(from.trim(), to.trim(), { mode: constants.COPYFILE_FICLONE, recursive: true });
  } catch (error) {
    // SAFETY: the git step throws a CliError, and the copy throws an Error from node:fs.
    return [`submodule repair failed: ${(error as Error).message}`];
  }
  for (const gitfile of broken) {
    rmSync(gitfile);
  }
  return [];
};

/**
 * Updates the submodules of the worktree at `dir`. `root` is the main checkout of the worktree. It repairs the `.git` files that omp clone
 * mode copied, then runs `git submodule update --init --recursive`. It gives the warnings in the sequence of the steps: the repair warning
 * first, then the update warning.
 */
export const updateSubmodules = async (root: string, dir: string): Promise<string[]> => {
  const warnings = await repairClonedSubmodules(root, dir);
  const result = await gitRun(dir, 'submodule', 'update', '--init', '--recursive');
  return result.status === 0 ? warnings : [...warnings, `submodule update failed: ${result.stderr.trim()}`];
};

/** The paths of the initialized submodules of the worktree at `dir`, at each depth, relative to `dir`. A submodule comes before the submodules in it. */
export const submodules = async (dir: string): Promise<string[]> => lines(await gitMust(dir, 'submodule', 'foreach', '--quiet', '--recursive', 'printf "%s\\n" "$displaypath"'));

/** The short hashes of the commits of `HEAD` and of the local branches of the repository at `dir` that no remote branch holds. */
export const unpushedCommits = async (dir: string): Promise<string[]> => lines(await gitMust(dir, 'rev-list', '--abbrev-commit', 'HEAD', '--branches', '--not', '--remotes'));

/** The ignored files of the worktree at `dir`, one entry for each file, as paths relative to `dir`. It does not look into submodules. */
export const ignoredFiles = async (dir: string): Promise<string[]> => {
  const output = await gitMust(dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard');
  return output.split('\0').filter(file => file !== '');
};
