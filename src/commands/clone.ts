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

const SLUG = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<name>(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]*)$/u;

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

/**
 * Gives the clone path `<cloneRoot>/<owner>/<name>` of `slug`, and if that path holds a clone of `slug`.
 * Throws `path_conflict` when the path holds something else.
 */
export const cloneDestination = async (slug: RepoSlug): Promise<{ root: string; present: boolean }> => {
  const root = path.join(loadConfig().cloneRoot, slug.owner, slug.name);
  if (!existsSync(root)) {
    return { present: false, root };
  }
  const originRepo = (await isCheckoutTop(root)) ? await originSlug(root) : null;
  if (originRepo?.owner === slug.owner && originRepo.name === slug.name) {
    return { present: true, root };
  }
  throw new CliError('path_conflict', `${root} exists and is not a clone of ${slug.owner}/${slug.name}`, { path: root });
};

/** Clones `slug` to `<cloneRoot>/<owner>/<name>`, or reuses the clone at that path. Throws `path_conflict` when the path holds something else. */
export const cloneRepo = async (slug: RepoSlug): Promise<CloneResult> => {
  const { present, root } = await cloneDestination(slug);
  if (present) {
    return { cloned: false, root };
  }
  mkdirSync(path.dirname(root), { recursive: true });
  await must(['gh', 'repo', 'clone', `${slug.owner}/${slug.name}`, root], 'gh_failed');
  return { cloned: true, root };
};

/** `clone <owner/name>`: clones the GitHub repository into the clone root, or reuses the clone there. */
export const run = async (args: string[]): Promise<CloneResult> => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  return await cloneRepo(parseSlug('clone', positionals));
};
