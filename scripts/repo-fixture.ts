import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitMustWith } from '../src/git.ts';
import type { RunOptions } from '../src/proc.ts';

/** Runs git in `cwd` and returns its `stdout`. */
export type Git = (cwd: string, ...args: string[]) => Promise<string>;

/** A clone of a bare `origin`, with one commit on `main` and `origin/HEAD` set. */
export interface RepoFixture {
  origin: string;
  dir: string;
  pushBranch: (name: string) => Promise<void>;
}

/** Makes a {@link Git} that runs each call with `opts`. */
export const gitWith =
  (opts: RunOptions = {}): Git =>
  async (cwd, ...args) =>
    await gitMustWith(opts, cwd, ...args);

/** Builds a {@link RepoFixture} with `origin.git` and the clone `name` in `base`. The commit holds a `README.md` with `readme`. */
export const buildRepo = async (git: Git, base: string, name: string, readme: string): Promise<RepoFixture> => {
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, name);
  await git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  await git(base, 'clone', '--quiet', origin, dir);
  await git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.md'), readme);
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '--quiet', '-m', 'initial');
  await git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  await git(dir, 'remote', 'set-head', 'origin', 'main');
  return {
    dir,
    origin,
    pushBranch: async (branch: string) => {
      await git(dir, 'push', '--quiet', 'origin', `main:refs/heads/${branch}`);
    },
  };
};
