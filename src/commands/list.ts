import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { currentBranch, dirtyFiles, linkedWorktreeRoot, requireRepoRoot } from '../git.ts';
import { worktreeOwner, worktreeRoot } from '../paths.ts';
import type { WorktreeRoot } from '../paths.ts';

/** A tern-managed worktree: its path, its repository, its branch, and `dirty`, true when it has uncommitted changes. */
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

const readWorktree = async (root: WorktreeRoot, dir: string): Promise<ListedWorktree | null> => {
  const repo = await linkedWorktreeRoot(dir);
  if (repo === null || worktreeOwner(root, repo, dir) !== 'tern') {
    return null;
  }
  const [branch, changedFiles] = await Promise.all([currentBranch(dir), dirtyFiles(dir)]);
  return { branch, dirty: changedFiles.length > 0, path: dir, repo };
};

/**
 * `list [--repo <dir>]`: the tern-managed worktrees of all repositories, or only of the repository that holds `dir`.
 * It skips each checkout one level below the root, an omp-owned worktree, and does not look in it.
 */
export const run = async (args: string[]): Promise<ListResult> => {
  const { repo } = parseArgs({ args, options: { repo: { type: 'string' } } }).values;
  const root = await worktreeRoot();
  const mainCheckout = repo === undefined ? null : await requireRepoRoot(repo);
  const repos = mainCheckout === null ? subdirs(root.dir) : [path.join(root.dir, path.basename(mainCheckout))];
  const found = await Promise.all(
    repos
      .filter(dir => !existsSync(path.join(dir, '.git')))
      .flatMap(subdirs)
      .map(async dir => await readWorktree(root, dir)),
  );
  return {
    root: root.dir,
    worktrees: found.filter((entry): entry is ListedWorktree => entry !== null && (mainCheckout === null || entry.repo === mainCheckout)),
  };
};
