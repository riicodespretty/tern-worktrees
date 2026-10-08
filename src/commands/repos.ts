import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { clonePath, ghMust, ghRun, parseRepoRef } from '../github.ts';

/** A GitHub repository. `local` is its clone in the clone root, or null when the clone path has no clone of this repository. */
export interface GithubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  description: string;
  local: string | null;
}

/** The GitHub repositories of the user and of each organization of the user. */
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
  const result = await ghRun('org', 'list');
  if (result.status !== 0) {
    warnings.push(`org list failed: ${result.stderr.trim()}`);
    return [];
  }
  return result.stdout.split('\n').filter(org => org !== '');
};

const listRepos = async (owner: string, warnings: string[]): Promise<OwnerRepos | null> => {
  const result = await ghRun('repo', 'list', owner, '--limit', '200', '--json', 'nameWithOwner,isPrivate,description');
  if (result.status !== 0) {
    warnings.push(`repo list ${owner} failed: ${result.stderr.trim()}`);
    return null;
  }
  // SAFETY: `gh repo list --json` prints an array with the fields it names.
  return { owner, repos: JSON.parse(result.stdout) as GhRepo[] };
};

const localClone = async (cloneRoot: string, text: string): Promise<string | null> => {
  const repoRef = parseRepoRef(text);
  if (repoRef === null) {
    return null;
  }
  const { root, state } = await clonePath(repoRef, cloneRoot);
  return state === 'clone' ? root : null;
};

/** `repos`: the GitHub repositories of the user and of each organization of the user, with the local clone of each. When the repository list of an organization fails, the result does not include that organization and has a warning. */
export const run = async (args: string[]): Promise<ReposResult> => {
  parseArgs({ args, options: {} });
  const { cloneRoot } = loadConfig();
  const loginOutput = await ghMust('api', 'user', '--jq', '.login');
  const login = loginOutput.trim();
  const warnings: string[] = [];
  const orgs = await listOrgs(warnings);
  const ownerRepos = await Promise.all([login, ...orgs].map(async owner => await listRepos(owner, warnings)));
  const listed = ownerRepos.filter(entry => entry !== null);
  const repos = await Promise.all(listed.flatMap(entry => entry.repos).map(async repo => ({ ...repo, local: await localClone(cloneRoot, repo.nameWithOwner) })));
  return { owners: listed.map(entry => entry.owner), repos, warnings };
};
