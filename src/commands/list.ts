import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dirtyFiles, repoRoot } from '../git.ts';
import { worktreeRoot } from '../paths.ts';
import { CliError, run as runProcess } from '../proc.ts';

/** A managed worktree, the repository it belongs to, its branch and if it has uncommitted changes. */
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

/** The main checkout of the repository when `dir` is the top directory of one of its linked worktrees, else null. */
export const linkedWorktreeRoot = async (dir: string): Promise<string | null> => {
  const [root, top] = await Promise.all([repoRoot(dir), runProcess(['git', '-C', dir, 'rev-parse', '--show-toplevel'])]);
  const real = realpathSync(dir);
  return top.stdout.trim() === real && root !== real ? root : null;
};

/** The branch checked out at `dir`, or null when its `HEAD` is detached. */
export const currentBranch = async (dir: string): Promise<string | null> => {
  const result = await runProcess(['git', '-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const name = result.stdout.trim();
  return name === '' ? null : name;
};

const subdirs = (dir: string): string[] => {
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name))
    .toSorted((left, right) => left.localeCompare(right, 'en'));
};

const inspect = async (dir: string): Promise<ListedWorktree | null> => {
  const repo = await linkedWorktreeRoot(dir);
  if (repo === null) {
    return null;
  }
  const [branch, files] = await Promise.all([currentBranch(dir), dirtyFiles(dir)]);
  return { branch, dirty: files.length > 0, path: dir, repo };
};

const repoDirs = async (root: string, repo: string | undefined): Promise<string[]> => {
  if (repo === undefined) {
    return subdirs(root);
  }
  const main = await repoRoot(repo);
  if (main === null) {
    throw new CliError('not_a_repo', `${repo} is not in a git repository`);
  }
  return [path.join(root, path.basename(main))];
};

/** `list [--repo <dir>]`: the managed worktrees of all repositories, or only of the repository that holds `dir`. */
export const run = async (args: string[]): Promise<ListResult> => {
  let repo: string | undefined;
  try {
    ({ repo } = parseArgs({ args, options: { repo: { type: 'string' } } }).values);
  } catch (error) {
    // SAFETY: `parseArgs` throws a TypeError for each bad argument.
    throw new CliError('bad_args', (error as TypeError).message);
  }
  const root = worktreeRoot();
  const repos = await repoDirs(root, repo);
  const found = await Promise.all(repos.flatMap(subdirs).map(inspect));
  return { root, worktrees: found.filter((entry): entry is ListedWorktree => entry !== null) };
};
