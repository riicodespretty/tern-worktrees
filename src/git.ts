import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CliError, must, run } from './proc.ts';
import type { RunOptions, RunResult } from './proc.ts';

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

/** Like {@link gitMust}, but runs git with `opts`: the working directory and the env vars that git gets. Pass `undefined` for the defaults. */
export const gitMustWith = async (opts: RunOptions | undefined, dir: string, ...args: string[]): Promise<string> => await must(['git', '-C', dir, ...args], 'git_failed', opts);

/** Runs `git -C <dir> <args>` and returns its standard output. Throws `git_failed` when git exits with a status other than 0. */
export const gitMust = async (dir: string, ...args: string[]): Promise<string> => await gitMustWith(undefined, dir, ...args);

/** Tells if `git -C <dir> <args>` exits with status 0. */
export const gitSucceeds = async (dir: string, ...args: string[]): Promise<boolean> => {
  const result = await gitRun(dir, ...args);
  return result.status === 0;
};

/** Tells if `commit` is an ancestor of `of` in the repository at `dir`, or the same commit. */
export const isAncestor = async (dir: string, commit: string, of: string): Promise<boolean> => await gitSucceeds(dir, 'merge-base', '--is-ancestor', commit, of);

/** The main checkout of the repository that holds `dir`, or null when `dir` is not in a repository with a checkout. */
export const repoRoot = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const commonDir = result.stdout.trim();
  if (!commonDir.endsWith('/.git')) {
    return null;
  }
  return path.dirname(commonDir);
};

/** Like {@link repoRoot}, but throws `not_a_repo` when `dir` is not in a repository with a checkout. */
export const requireRepoRoot = async (dir: string): Promise<string> => {
  const root = await repoRoot(dir);
  if (root === null) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return root;
};

/** The main checkout of the repository when `dir` is the top directory of one of its linked worktrees, else null. */
export const linkedWorktreeRoot = async (dir: string): Promise<string | null> => {
  const [root, topLevel] = await Promise.all([repoRoot(dir), gitRun(dir, 'rev-parse', '--show-toplevel')]);
  if (root === null) {
    return null;
  }
  const realDir = realpathSync(dir);
  return topLevel.stdout.trim() === realDir && root !== realDir ? root : null;
};

/** The branch checked out at `dir`, or null when `dir` has a detached `HEAD`. A tag of the same name does not change it. */
export const currentBranch = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, 'symbolic-ref', '-q', 'HEAD');
  const ref = result.stdout.trim();
  return ref === '' ? null : ref.slice('refs/heads/'.length);
};

/** Tells if `dir`, which must be on disk, is the top directory of a checkout and not a subdirectory of one. It compares real paths, because git reports real paths. */
export const isCheckoutTop = async (dir: string): Promise<boolean> => (await repoRoot(dir)) === realpathSync(dir);

/** The URL of the `origin` remote of the repository at `root`, or an empty string without one. */
export const originUrl = async (root: string): Promise<string> => {
  const result = await gitRun(root, 'remote', 'get-url', 'origin');
  return result.stdout.trim();
};

/** Tells if the repository at `root` has a remote named `origin`. */
export const hasOrigin = async (root: string): Promise<boolean> => (await originUrl(root)) !== '';

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

/**
 * The `git status --porcelain` lines of the worktree at `dir`, submodule changes included. It lists each file that git does not track,
 * also when `status.showUntrackedFiles` hides them.
 */
export const dirtyFiles = async (dir: string): Promise<string[]> => lines(await gitMust(dir, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'));

const submodules = async (dir: string): Promise<string[]> => lines(await gitMust(dir, 'submodule', 'foreach', '--quiet', '--recursive', 'printf "%s\\n" "$displaypath"'));

const submoduleLosses = async (dir: string, sub: string): Promise<string[]> => {
  const subDir = path.join(dir, sub);
  const [files, unpushed] = await Promise.all([dirtyFiles(subDir), gitMust(subDir, 'rev-list', '--abbrev-commit', 'HEAD', '--branches', '--not', '--remotes')]);
  return [...files.map(file => `${sub}: ${file}`), ...lines(unpushed).map(commit => `${sub}: unpushed ${commit}`)];
};

/**
 * The work that a delete of the worktree at `dir` destroys, ignored files aside: its {@link dirtyFiles}, and for each initialized submodule,
 * at each depth, its dirty files and the commits of its `HEAD` or its local branches that no remote branch holds. Empty when the delete destroys nothing.
 */
export const worktreeLosses = async (dir: string): Promise<string[]> => {
  const [files, subs] = await Promise.all([dirtyFiles(dir), submodules(dir)]);
  const subLosses = await Promise.all(subs.map(async sub => await submoduleLosses(dir, sub)));
  return [...files, ...subLosses.flat()];
};

/** The path segments of the ignored files that a build or an install makes again. An ignored file with none of them in its path is hard to rebuild. */
export const REBUILDABLE: readonly string[] = ['node_modules', 'dist', 'build', 'coverage', '.DS_Store', '.cache', '.next', '.nuxt', '.output', '.turbo'];

const ignoredFiles = async (dir: string): Promise<string[]> => {
  const output = await gitMust(dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard');
  return output.split('\0').filter(file => file !== '');
};

/**
 * The ignored files of the worktree at `dir` and of its initialized submodules at each depth that are hard to rebuild, one entry for each file,
 * as paths relative to `dir`.
 */
export const hardToRebuild = async (dir: string): Promise<string[]> => {
  const [own, subs] = await Promise.all([ignoredFiles(dir), submodules(dir)]);
  const nested = await Promise.all(
    subs.map(async sub => {
      const files = await ignoredFiles(path.join(dir, sub));
      return files.map(file => `${sub}/${file}`);
    }),
  );
  return [...own, ...nested.flat()].filter(file => !file.split('/').some(segment => REBUILDABLE.includes(segment)));
};

/** The size of each chunk that {@link sameFile} compares. */
const COMPARE_CHUNK = 64 * 1024;

/** Reads into `buffer` from `fd` until it is full or the file ends. Returns the count of bytes read. */
const readChunk = (fd: number, buffer: Buffer): number => {
  let filled = 0;
  for (;;) {
    const count = readSync(fd, buffer, filled, buffer.length - filled, null);
    if (count === 0) {
      return filled;
    }
    filled += count;
  }
};

/** Tells if `left` and `right` are regular files with the same bytes. It compares them chunk by chunk and stops at the first difference. */
const sameFile = (left: string, right: string): boolean => {
  if (![left, right].every(file => lstatSync(file, { throwIfNoEntry: false })?.isFile() === true)) {
    return false;
  }
  const leftFd = openSync(left, 'r');
  try {
    const rightFd = openSync(right, 'r');
    try {
      const [leftChunk, rightChunk] = [Buffer.alloc(COMPARE_CHUNK), Buffer.alloc(COMPARE_CHUNK)];
      for (;;) {
        const leftCount = readChunk(leftFd, leftChunk);
        const rightCount = readChunk(rightFd, rightChunk);
        if (!leftChunk.subarray(0, leftCount).equals(rightChunk.subarray(0, rightCount))) {
          return false;
        }
        if (leftCount < COMPARE_CHUNK) {
          return true;
        }
      }
    } finally {
      closeSync(rightFd);
    }
  } finally {
    closeSync(leftFd);
  }
};

/**
 * The {@link hardToRebuild} files of the worktree at `dir` that a delete loses: each one that the main checkout at `mainCheckout` does not hold
 * with the same bytes at the same relative path. A copy of a file of the main checkout, for example a `.env` that a clone carried, is not work to lose.
 */
export const hardToRebuildChanges = async (dir: string, mainCheckout: string): Promise<string[]> => {
  const files = await hardToRebuild(dir);
  return files.filter(file => !sameFile(path.join(dir, file), path.join(mainCheckout, file)));
};
