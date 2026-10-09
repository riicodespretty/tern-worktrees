import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../git.ts';
import { originRepo } from '../github.ts';

/** The repository that holds a directory, with null values when the directory is not in a repository. */
export interface ResolvedDir {
  dir: string;
  root: string | null;
  name: string | null;
  owner: string | null;
}

const resolveDir = async (dir: string): Promise<ResolvedDir> => {
  const root = await repoRoot(dir);
  if (root === null) {
    return { dir, name: null, owner: null, root: null };
  }
  const repoRef = await originRepo(root);
  return { dir, name: path.basename(root), owner: repoRef?.owner ?? null, root };
};

/** `resolve <dir>...`: the repository root, name and GitHub owner of each directory. Each distinct directory resolves once. */
export const run = async (args: string[]): Promise<{ repos: ResolvedDir[] }> => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  const byDir = new Map<string, Promise<ResolvedDir>>();
  const repos = positionals.map(async dir => {
    const resolving = byDir.get(dir) ?? resolveDir(dir);
    byDir.set(dir, resolving);
    return await resolving;
  });
  return { repos: await Promise.all(repos) };
};
