import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { isCheckoutTop, nameWithOwner, originRepo } from './git.ts';
import type { GithubRepoRef } from './git.ts';
import { CliError, must } from './proc.ts';

/** The path of the clone of a GitHub repository, and if a clone call made it. */
export interface GithubClone {
  root: string;
  cloned: boolean;
}

const NAME_WITH_OWNER = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<name>(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]*)$/u;

/** Reads the one `<owner/name>` positional of `command`, or throws `bad_args`. */
export const parseNameWithOwner = (command: string, positionals: string[]): GithubRepoRef => {
  const groups = positionals.length === 1 ? NAME_WITH_OWNER.exec(positionals[0])?.groups : undefined;
  if (!groups) {
    throw new CliError('bad_args', `${command} needs one <owner/name>`);
  }
  return { name: groups.name, owner: groups.owner };
};

/**
 * Gives the clone path `<cloneRoot>/<owner>/<name>` of `repoRef`, and if that path holds a clone of `repoRef`.
 * Throws `path_conflict` when the path holds something else.
 */
export const cloneDestination = async (repoRef: GithubRepoRef): Promise<{ root: string; present: boolean }> => {
  const root = path.join(loadConfig().cloneRoot, repoRef.owner, repoRef.name);
  if (!existsSync(root)) {
    return { present: false, root };
  }
  const origin = (await isCheckoutTop(root)) ? await originRepo(root) : null;
  if (origin?.owner === repoRef.owner && origin.name === repoRef.name) {
    return { present: true, root };
  }
  throw new CliError('path_conflict', `${root} exists and is not a clone of ${nameWithOwner(repoRef)}`, { path: root });
};

/** Clones `repoRef` to `<cloneRoot>/<owner>/<name>`, or reuses the clone at that path. Throws `path_conflict` when the path holds something else. */
export const cloneRepo = async (repoRef: GithubRepoRef): Promise<GithubClone> => {
  const { present, root } = await cloneDestination(repoRef);
  if (present) {
    return { cloned: false, root };
  }
  mkdirSync(path.dirname(root), { recursive: true });
  await must(['gh', 'repo', 'clone', nameWithOwner(repoRef), root], 'gh_failed');
  return { cloned: true, root };
};
