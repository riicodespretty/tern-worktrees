import { parseArgs } from 'node:util';
import { CliError, must } from '../proc.ts';
import { cloneRepo, parseSlug } from './clone.ts';

/** The clone of a new GitHub repository. */
export interface NewRepoResult {
  root: string;
  nameWithOwner: string;
}

/** `new-repo <owner/name> --visibility private|public`: creates the GitHub repository with a README, then clones it into the clone root. */
export const run = async (args: string[]): Promise<NewRepoResult> => {
  const { positionals, values } = parseArgs({ allowPositionals: true, args, options: { visibility: { type: 'string' } } });
  const slug = parseSlug('new-repo', positionals);
  const { visibility } = values;
  if (visibility !== 'private' && visibility !== 'public') {
    throw new CliError('bad_args', 'new-repo needs --visibility private or public');
  }
  const nameWithOwner = `${slug.owner}/${slug.name}`;
  await must(['gh', 'repo', 'create', nameWithOwner, `--${visibility}`, '--add-readme'], 'gh_failed');
  const { root } = await cloneRepo(slug);
  return { nameWithOwner, root };
};
