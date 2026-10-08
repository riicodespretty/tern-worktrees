import { parseArgs } from 'node:util';
import { cloneDestination, cloneRepo, ghMust, nameWithOwner, parseNameWithOwner } from '../github.ts';
import { CliError } from '../proc.ts';

/** The clone of a new GitHub repository. */
export interface NewRepoResult {
  root: string;
  nameWithOwner: string;
}

/** `new-repo <owner/name> --visibility private|public`: checks that the clone path is free, creates the GitHub repository with a README, then clones it into the clone root. */
export const run = async (args: string[]): Promise<NewRepoResult> => {
  const { positionals, values } = parseArgs({ allowPositionals: true, args, options: { visibility: { type: 'string' } } });
  const repoRef = parseNameWithOwner('new-repo', positionals);
  const { visibility } = values;
  if (visibility !== 'private' && visibility !== 'public') {
    throw new CliError('bad_args', 'new-repo needs --visibility private or public');
  }
  await cloneDestination(repoRef);
  await ghMust('repo', 'create', nameWithOwner(repoRef), `--${visibility}`, '--add-readme');
  const { root } = await cloneRepo(repoRef);
  return { nameWithOwner: nameWithOwner(repoRef), root };
};
