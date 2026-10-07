import path from 'node:path';
import { parseArgs } from 'node:util';
import { originSlug, repoRoot } from '../git.ts';

/** The repository that holds a directory, with null values when the directory is not in a repository. */
export interface ResolvedDir {
  dir: string;
  root: string | null;
  name: string | null;
  owner: string | null;
}

const describe = async (dir: string): Promise<ResolvedDir> => {
  const root = await repoRoot(dir);
  if (root === null) {
    return { dir, name: null, owner: null, root: null };
  }
  const slug = await originSlug(root);
  return { dir, name: path.basename(root), owner: slug?.owner ?? null, root };
};

/** `resolve <dir>...`: the repository root, name and GitHub owner of each directory. Each distinct directory resolves once. */
export const run = async (args: string[]): Promise<{ repos: ResolvedDir[] }> => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  const pending = new Map<string, Promise<ResolvedDir>>();
  const repos = positionals.map(async dir => {
    const known = pending.get(dir) ?? describe(dir);
    pending.set(dir, known);
    return await known;
  });
  return { repos: await Promise.all(repos) };
};
