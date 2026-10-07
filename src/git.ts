import { realpathSync } from 'node:fs';
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

/** The GitHub owner and name of a repository. */
export interface GithubRepoRef {
  owner: string;
  name: string;
}

/** The `<owner>/<name>` form of `repoRef`, the name that `gh` uses for a repository. */
export const nameWithOwner = (repoRef: GithubRepoRef): string => `${repoRef.owner}/${repoRef.name}`;

/** Runs `git -C <dir> <args>`, waits for it to exit, and returns its output. */
export const gitRun = async (dir: string, ...args: string[]): Promise<RunResult> => await run(['git', '-C', dir, ...args]);

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

/** Tells if the directory `dir`, which must be on disk, is the top of a checkout and not a dir in one. It compares real paths, because git gives them. */
export const isCheckoutTop = async (dir: string): Promise<boolean> => (await repoRoot(dir)) === realpathSync(dir);

const GITHUB_URL = /^(?:git@github\.com:|https:\/\/github\.com\/)(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/u;

const originUrl = async (root: string): Promise<string> => {
  const result = await gitRun(root, 'remote', 'get-url', 'origin');
  return result.stdout.trim();
};

/** Tells if the repository at `root` has a remote named `origin`. */
export const hasOrigin = async (root: string): Promise<boolean> => (await originUrl(root)) !== '';

/**
 * Fetches `origin` in the repository at `root`, and prunes its deleted branches when `prune` is true.
 * Gives a warning that starts with `fetch failed:` when the fetch fails, else null.
 */
export const fetchOrigin = async (root: string, prune: boolean): Promise<string | null> => {
  const result = await gitRun(root, 'fetch', ...(prune ? ['--prune'] : []), 'origin');
  return result.status === 0 ? null : `fetch failed: ${result.stderr.trim()}`;
};

/** The GitHub owner and name from the `origin` URL, or null without a GitHub origin. */
export const originRepo = async (root: string): Promise<GithubRepoRef | null> => {
  const groups = GITHUB_URL.exec(await originUrl(root))?.groups;
  if (!groups) {
    return null;
  }
  return { name: groups.name, owner: groups.owner };
};

/** The default branch: `origin/HEAD`, else what GitHub reports, else the current branch when the repository has no GitHub origin. `offline` skips GitHub. */
export const defaultBranch = async (root: string, { offline = false }: { offline?: boolean } = {}): Promise<string> => {
  const head = await gitRun(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.status === 0) {
    return head.stdout.trim().slice('origin/'.length);
  }
  const repoRef = offline ? null : await originRepo(root);
  if (repoRef !== null) {
    const name = await must(['gh', 'repo', 'view', nameWithOwner(repoRef), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 'gh_failed');
    return name.trim();
  }
  const current = await must(['git', '-C', root, 'branch', '--show-current'], 'git_failed');
  return current.trim();
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
  const output = await must(['git', '-C', root, 'worktree', 'list', '--porcelain', '-z'], 'git_failed');
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
export const dirtyFiles = async (dir: string): Promise<string[]> =>
  lines(await must(['git', '-C', dir, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], 'git_failed'));

const submodules = async (dir: string): Promise<string[]> =>
  lines(await must(['git', '-C', dir, 'submodule', 'foreach', '--quiet', '--recursive', 'printf "%s\\n" "$displaypath"'], 'git_failed'));

const submoduleLosses = async (dir: string, sub: string): Promise<string[]> => {
  const subDir = path.join(dir, sub);
  const [files, unpushed] = await Promise.all([
    dirtyFiles(subDir),
    must(['git', '-C', subDir, 'rev-list', '--abbrev-commit', 'HEAD', '--branches', '--not', '--remotes'], 'git_failed'),
  ]);
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
  const output = await must(['git', '-C', dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], 'git_failed');
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
