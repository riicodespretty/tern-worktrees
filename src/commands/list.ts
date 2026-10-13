import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { changedFileCount, checkoutAt, currentBranch, requireRepoRoot } from '../git.ts';
import { worktreeOwner, worktreeRoot } from '../paths.ts';
import type { WorktreeRoot } from '../paths.ts';

/**
 * A worktree in the worktree root, with its path, repository and branch. `dirty` is true when the worktree has uncommitted changes.
 * `changed` is the number of its changed files. `owner` is `tern` for a tern-managed worktree and `omp` for an omp-owned one.
 */
export interface ListedWorktree {
  path: string;
  repo: string;
  branch: string | null;
  dirty: boolean;
  changed: number;
  owner: 'tern' | 'omp';
}

/** The output of `list`. `warnings` names each worktree in the output where git could not count the changed files, with the git error. */
export interface ListResult {
  root: string;
  warnings: string[];
  worktrees: ListedWorktree[];
}

/** A worktree that `list` found, and the warning about its changed-file count, or null. */
interface Found {
  warning: string | null;
  worktree: ListedWorktree;
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

/**
 * Reads the worktree at `dir`. When git cannot count its changed files, for example because a submodule has a broken `.git` file,
 * the worktree stays in the list with the count that does not include the submodules, and gets a warning.
 */
const readWorktree = async (root: WorktreeRoot, dir: string, all: boolean): Promise<Found | null> => {
  const checkout = await checkoutAt(dir);
  if (checkout?.role !== 'linked') {
    return null;
  }
  const mainCheckout = checkout.root;
  const owner = worktreeOwner(root, mainCheckout, dir);
  if (owner === null || (owner === 'omp' && !all)) {
    return null;
  }
  const [branch, changed] = await Promise.all([currentBranch(dir), changedFileCount(dir)]);
  return {
    warning: changed.error === null ? null : `changed files not counted in ${dir}: ${changed.error}`,
    worktree: { branch, changed: changed.count, dirty: changed.count > 0, owner, path: dir, repo: mainCheckout },
  };
};

/**
 * `list [--repo <dir>] [--all]`: the tern-managed worktrees of all repositories, or only of the repository that contains `dir`.
 * With `--all`, it also lists the omp-owned worktrees. It does not look in a worktree or a main checkout.
 */
export const run = async (args: string[]): Promise<ListResult> => {
  const { all, repo } = parseArgs({ args, options: { all: { default: false, type: 'boolean' }, repo: { type: 'string' } } }).values;
  const root = await worktreeRoot();
  const mainCheckout = repo === undefined ? null : await requireRepoRoot(repo);
  const startDir = mainCheckout === null || all ? root.dir : path.join(root.dir, path.basename(mainCheckout));
  const found = await Promise.all(walk(startDir).map(async dir => await readWorktree(root, dir, all)));
  const listed = found.filter((entry): entry is Found => entry !== null && (mainCheckout === null || entry.worktree.repo === mainCheckout));
  return {
    root: root.dir,
    warnings: listed.flatMap(entry => (entry.warning === null ? [] : [entry.warning])),
    worktrees: listed.map(entry => entry.worktree),
  };
};
