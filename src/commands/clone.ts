import { parseArgs } from 'node:util';
import { cloneRepo, parseNameWithOwner } from '../github.ts';
import type { GithubClone } from '../github.ts';

/** The path of the clone of a GitHub repository, and if this command cloned it. */
export type CloneResult = GithubClone;

/** `clone <owner/name>`: clones the GitHub repository into the clone root, or reuses the clone there. */
export const run = async (args: string[]): Promise<CloneResult> => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  return await cloneRepo(parseNameWithOwner('clone', positionals));
};
