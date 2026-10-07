import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { currentBranch, dirtyFiles, linkedWorktreeRoot, requireRepoRoot } from '../git.ts';
import { worktreeRoot } from '../paths.ts';

/** A managed worktree: its path, its repository, its branch, and `dirty`, true when it has uncommitted changes. */
export interface ListedWorktree {
  path: string;
  repo: string;
  branch: string | null;
  dirty: boolean;
}

/** The output of `list`. */
export interface ListResult {
  root: string;
  worktrees: ListedWorktree[];
}

const subdirs = (dir: string): string[] => {
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name))
    .toSorted((left, right) => left.localeCompare(right, 'en'));
};

const readWorktree = async (dir: string): Promise<ListedWorktree | null> => {
  const repo = await linkedWorktreeRoot(dir);
  if (repo === null) {
    return null;
  }
  const [branch, changedFiles] = await Promise.all([currentBranch(dir), dirtyFiles(dir)]);
  return { branch, dirty: changedFiles.length > 0, path: dir, repo };
};

/** `list [--repo <dir>]`: the managed worktrees of all repositories, or only of the repository that holds `dir`. */
export const run = async (args: string[]): Promise<ListResult> => {
  const { repo } = parseArgs({ args, options: { repo: { type: 'string' } } }).values;
  const root = worktreeRoot();
  const mainCheckout = repo === undefined ? null : await requireRepoRoot(repo);
  const repos = mainCheckout === null ? subdirs(root) : [path.join(root, path.basename(mainCheckout))];
  const found = await Promise.all(repos.flatMap(subdirs).map(readWorktree));
  return { root, worktrees: found.filter((entry): entry is ListedWorktree => entry !== null && (mainCheckout === null || entry.repo === mainCheckout)) };
};
