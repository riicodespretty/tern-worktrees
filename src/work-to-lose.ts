import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { dirtyFiles, ignoredFiles, submodules, unpushedCommits } from './git.ts';
import { CliError } from './proc.ts';

/**
 * The operation to stop when the worktree has work to lose. It is `'recreating'` for relocate, or `{ removing }` for teardown, where `removing`
 * is the path of the main checkout of the worktree.
 */
export type Guarded = 'recreating' | { removing: string };

/** The path segments of the ignored files that a build or an install makes again. An ignored file with none of them in its path is hard to rebuild. */
export const REBUILDABLE: readonly string[] = ['node_modules', 'dist', 'build', 'coverage', '.DS_Store', '.cache', '.next', '.nuxt', '.output', '.turbo'];

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

/** The changes of the worktree at `dir`, and for each submodule in `subs`, its changes and the commits that no remote branch holds. */
const changesIn = async (dir: string, subs: string[]): Promise<string[]> => {
  const [own, nested] = await Promise.all([
    dirtyFiles(dir),
    Promise.all(
      subs.map(async sub => {
        const subDir = path.join(dir, sub);
        const [files, commits] = await Promise.all([dirtyFiles(subDir), unpushedCommits(subDir)]);
        return [...files.map(file => `${sub}: ${file}`), ...commits.map(commit => `${sub}: unpushed ${commit}`)];
      }),
    ),
  ]);
  return [...own, ...nested.flat()];
};

/** The ignored files of the worktree at `dir` and of each submodule in `subs` that are hard to rebuild, as paths relative to `dir`. */
const hardToRebuildIn = async (dir: string, subs: string[]): Promise<string[]> => {
  const ignoredIn = async (sub: string): Promise<string[]> => {
    const files = await ignoredFiles(path.join(dir, sub));
    return files.map(file => `${sub}/${file}`);
  };
  const [own, nested] = await Promise.all([ignoredFiles(dir), Promise.all(subs.map(ignoredIn))]);
  return [...own, ...nested.flat()].filter(file => !file.split('/').some(segment => REBUILDABLE.includes(segment)));
};

/**
 * Throws `dirty_worktree` when `operation` stops on the work to lose in the worktree at `dir`, submodules at each depth included. Relocate
 * stops only on changes, and gives each hard-to-rebuild file to carry. Teardown gives an empty list. It also stops on each hard-to-rebuild
 * file that is not the same, byte for byte, as the file at the same path in the main checkout.
 *
 * The error holds `changes`, `hardToRebuild` and `files`. `changes` holds the `git status --porcelain` lines, then for each submodule its
 * `<sub>: <line>` and `<sub>: unpushed <commit>` entries. `hardToRebuild` holds the blocking hard-to-rebuild files, relative to `dir`.
 * `files` holds the changes, then a `!! <path>` entry for each blocking hard-to-rebuild file.
 */
export const guardWorkToLose = async (dir: string, operation: Guarded): Promise<string[]> => {
  const subs = await submodules(dir);
  const [changes, hardToRebuild] = await Promise.all([changesIn(dir, subs), hardToRebuildIn(dir, subs)]);
  const { blocking, carried, doing }: { blocking: string[]; carried: string[]; doing: string } =
    operation === 'recreating'
      ? { blocking: [], carried: hardToRebuild, doing: operation }
      : { blocking: hardToRebuild.filter(file => !sameFile(path.join(dir, file), path.join(operation.removing, file))), carried: [], doing: 'removing' };
  const files = [...changes, ...blocking.map(file => `!! ${file}`)];
  if (files.length > 0) {
    throw new CliError('dirty_worktree', `${dir} has work that ${doing} it would lose`, { changes, existing: dir, files, hardToRebuild: blocking });
  }
  return carried;
};
