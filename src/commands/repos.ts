import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { must, run as runProcess } from '../proc.ts';
import { isCheckoutTop } from './clone.ts';

/** A GitHub repository, with its clone in the clone root or null. */
export interface GithubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  description: string;
  local: string | null;
}

/** The GitHub repositories of the user and of each org of the user. */
export interface ReposResult {
  owners: string[];
  repos: GithubRepo[];
  warnings: string[];
}

interface GhRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  description: string;
}

interface OwnerRepos {
  owner: string;
  repos: GhRepo[];
}

const listOrgs = async (warnings: string[]): Promise<string[]> => {
  const result = await runProcess(['gh', 'org', 'list']);
  if (result.status !== 0) {
    warnings.push(`org list failed: ${result.stderr.trim()}`);
    return [];
  }
  return result.stdout.split('\n').filter(org => org !== '');
};

const listRepos = async (owner: string, warnings: string[]): Promise<OwnerRepos | null> => {
  const result = await runProcess(['gh', 'repo', 'list', owner, '--limit', '200', '--json', 'nameWithOwner,isPrivate,description']);
  if (result.status !== 0) {
    warnings.push(`repo list ${owner} failed: ${result.stderr.trim()}`);
    return null;
  }
  // SAFETY: `gh repo list --json` prints an array with the fields it names.
  return { owner, repos: JSON.parse(result.stdout) as GhRepo[] };
};

const localClone = async (cloneRoot: string, nameWithOwner: string): Promise<string | null> => {
  const dir = path.join(cloneRoot, nameWithOwner);
  return existsSync(dir) && (await isCheckoutTop(dir)) ? dir : null;
};

/** `repos`: the GitHub repositories of the user and of each organization of the user, with the local clone of each. An organization whose list fails is left out with a warning. */
export const run = async (args: string[]): Promise<ReposResult> => {
  parseArgs({ args, options: {} });
  const { cloneRoot } = loadConfig();
  const user = await must(['gh', 'api', 'user', '--jq', '.login'], 'gh_failed');
  const login = user.trim();
  const warnings: string[] = [];
  const orgs = await listOrgs(warnings);
  const owners = await Promise.all([login, ...orgs].map(async owner => await listRepos(owner, warnings)));
  const listed = owners.filter(entry => entry !== null);
  const repos = await Promise.all(listed.flatMap(entry => entry.repos).map(async repo => ({ ...repo, local: await localClone(cloneRoot, repo.nameWithOwner) })));
  return { owners: listed.map(entry => entry.owner), repos, warnings };
};
