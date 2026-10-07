import path from 'node:path';
import { must, run } from './proc.ts';

/** One entry of `git worktree list`. */
export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  locked: boolean;
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

/** The default branch: `origin/HEAD`, else what GitHub reports, else the current branch when the repository has no GitHub origin. */
export const defaultBranch = async (root: string): Promise<string> => {
  const head = await run(['git', '-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0) {
    return head.stdout.trim().slice('origin/'.length);
  }
  const slug = await originSlug(root);
  if (slug !== null) {
    const name = await must(['gh', 'repo', 'view', `${slug.owner}/${slug.name}`, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 'gh_failed');
    return name.trim();
  }
  const current = await must(['git', '-C', root, 'branch', '--show-current'], 'git_failed');
  return current.trim();
};

const parseWorktree = (record: string, index: number): Worktree => {
  const [first, ...fields] = record.split('\0');
  const worktree: Worktree = { branch: null, head: '', locked: false, main: index === 0, path: first.slice('worktree '.length), prunable: false };
  for (const field of fields) {
    const [key] = field.split(' ');
    const value = field.slice(key.length + 1);
    if (key === 'HEAD') {
      worktree.head = value;
    } else if (key === 'branch') {
      worktree.branch = value.slice('refs/heads/'.length);
    } else if (key === 'locked') {
      worktree.locked = true;
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

/** The `git status --porcelain` lines of the worktree at `dir`, submodule changes included. */
export const dirtyFiles = async (dir: string): Promise<string[]> => {
  const output = await must(['git', '-C', dir, 'status', '--porcelain', '--ignore-submodules=none'], 'git_failed');
  return output.split('\n').filter(line => line !== '');
};
