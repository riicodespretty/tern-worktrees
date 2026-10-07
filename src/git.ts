import path from 'node:path';
import { must, run } from './proc.ts';

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
export interface RepoSlug {
  owner: string;
  name: string;
}

/** The main checkout of the repository that holds `dir`, or null when `dir` is not in a repository with a checkout. */
export const repoRoot = async (dir: string): Promise<string | null> => {
  const result = await run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = result.stdout.trim();
  if (!commonDir.endsWith('/.git')) {
    return null;
  }
  return path.dirname(commonDir);
};

const GITHUB_URL = /^(?:git@github\.com:|https:\/\/github\.com\/)(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/u;

/** The GitHub owner and name from the `origin` URL, or null without a GitHub origin. */
export const originSlug = async (root: string): Promise<RepoSlug | null> => {
  const result = await run(['git', '-C', root, 'remote', 'get-url', 'origin']);
  const groups = GITHUB_URL.exec(result.stdout.trim())?.groups;
  if (!groups) {
    return null;
  }
  return { name: groups.name, owner: groups.owner };
};

/** The default branch: `origin/HEAD`, else what GitHub reports, else the current branch when the repository has no GitHub origin. `offline` skips GitHub. */
export const defaultBranch = async (root: string, opts: { offline?: boolean } = {}): Promise<string> => {
  const head = await run(['git', '-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0) {
    return head.stdout.trim().slice('origin/'.length);
  }
  const slug = opts.offline === true ? null : await originSlug(root);
  if (slug !== null) {
    const name = await must(['gh', 'repo', 'view', `${slug.owner}/${slug.name}`, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 'gh_failed');
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
