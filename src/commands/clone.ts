import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { originSlug, repoRoot } from '../git.ts';
import type { RepoSlug } from '../git.ts';
import { CliError, must } from '../proc.ts';

/** The path of the clone of a GitHub repository, and if this command cloned it. */
export interface CloneResult {
  root: string;
  cloned: boolean;
}

const SLUG = /^(?<owner>[^/]+)\/(?<name>[^/]+)$/u;

/** Reads the one `<owner/name>` positional of `command`, or throws `bad_args`. */
export const parseSlug = (command: string, positionals: string[]): RepoSlug => {
  const groups = positionals.length === 1 ? SLUG.exec(positionals[0])?.groups : undefined;
  if (!groups) {
    throw new CliError('bad_args', `${command} needs one <owner/name>`);
  }
  return { name: groups.name, owner: groups.owner };
};

/** Tells if the directory `dir`, which must be on disk, is the top of a checkout and not a dir in one. It compares real paths, because git gives them. */
export const isCheckoutTop = async (dir: string): Promise<boolean> => (await repoRoot(dir)) === realpathSync(dir);

/** Clones `slug` to `<cloneRoot>/<owner>/<name>`, or reuses the clone at that path. Throws `path_conflict` when the path holds something else. */
export const cloneRepo = async (slug: RepoSlug): Promise<CloneResult> => {
  const nameWithOwner = `${slug.owner}/${slug.name}`;
  const root = path.join(loadConfig().cloneRoot, slug.owner, slug.name);
  if (existsSync(root)) {
    const originRepo = (await isCheckoutTop(root)) ? await originSlug(root) : null;
    if (originRepo?.owner === slug.owner && originRepo.name === slug.name) {
      return { cloned: false, root };
    }
    throw new CliError('path_conflict', `${root} exists and is not a clone of ${nameWithOwner}`, { path: root });
  }
  mkdirSync(path.dirname(root), { recursive: true });
  await must(['gh', 'repo', 'clone', nameWithOwner, root], 'gh_failed');
  return { cloned: true, root };
};

/** `clone <owner/name>`: clones the GitHub repository into the clone root, or reuses the clone there. */
export const run = async (args: string[]): Promise<CloneResult> => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  return await cloneRepo(parseSlug('clone', positionals));
};
