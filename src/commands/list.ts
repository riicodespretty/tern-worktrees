import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { currentBranch, dirtyFiles, linkedWorktreeRoot, requireRepoRoot } from '../git.ts';
import { worktreeOwner, worktreeRoot } from '../paths.ts';
import type { WorktreeRoot } from '../paths.ts';

/**
 * A worktree in the worktree root: its path, its repository, its branch, `dirty`, true when it has uncommitted changes,
 * `changed`, the number of its changed files, and `owner`, `tern` for a tern-managed worktree and `omp` for an omp-owned one.
 */
export interface ListedWorktree {
  path: string;
  repo: string;
  branch: string | null;
  dirty: boolean;
  changed: number;
  owner: 'tern' | 'omp';
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

/** The candidate folders from `dir` down: a folder with a `.git` entry is a candidate, and the walk does not enter it. It enters each other folder. */
const walk = (dir: string): string[] => (existsSync(path.join(dir, '.git')) ? [dir] : subdirs(dir).flatMap(walk));

const readWorktree = async (root: WorktreeRoot, dir: string, all: boolean): Promise<ListedWorktree | null> => {
  const repo = await linkedWorktreeRoot(dir);
  if (repo === null) {
    return null;
  }
  const owner = worktreeOwner(root, repo, dir);
  if (owner === null || (owner === 'omp' && !all)) {
    return null;
  }
  const [branch, changedFiles] = await Promise.all([currentBranch(dir), dirtyFiles(dir)]);
  return { branch, changed: changedFiles.length, dirty: changedFiles.length > 0, owner, path: dir, repo };
};

/**
 * `list [--repo <dir>] [--all]`: the tern-managed worktrees of all repositories, or only of the repository that holds `dir`.
 * With `--all`, it also lists the omp-owned worktrees. It does not look in a worktree or a checkout.
 */
export const run = async (args: string[]): Promise<ListResult> => {
  const { all, repo } = parseArgs({ args, options: { all: { default: false, type: 'boolean' }, repo: { type: 'string' } } }).values;
  const root = await worktreeRoot();
  const mainCheckout = repo === undefined ? null : await requireRepoRoot(repo);
  const start = mainCheckout === null || all ? root.dir : path.join(root.dir, path.basename(mainCheckout));
  const found = await Promise.all(walk(start).map(async dir => await readWorktree(root, dir, all)));
  return {
    root: root.dir,
    worktrees: found.filter((entry): entry is ListedWorktree => entry !== null && (mainCheckout === null || entry.repo === mainCheckout)),
  };
};
