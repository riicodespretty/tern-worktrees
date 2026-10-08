import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { gitMust, gitRun, isCheckoutTop, originUrl } from './git.ts';
import { CliError, must } from './proc.ts';

/** The GitHub owner and name of a repository. */
export interface GithubRepoRef {
  owner: string;
  name: string;
}

/** The path of the clone of a GitHub repository. `cloned` is true when this call ran `gh repo clone`, and false when it reused a clone that was there before. */
export interface GithubClone {
  root: string;
  cloned: boolean;
}

/** The clone path of a GitHub repository. `present` is true when the path holds a clone of the repository. `conflict` is true when the path holds something else. */
export interface CloneSlot {
  root: string;
  present: boolean;
  conflict: boolean;
}

/** A pull request as `gh pr list --json` and `gh pr view --json` print it. Each command asks for some of the fields. */
export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
}

const NAME_WITH_OWNER = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<name>(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]*)$/u;

const GITHUB_URL = /^(?:git@github\.com:|https:\/\/github\.com\/)(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/u;

/** The `<owner>/<name>` form of `repoRef`, the name that `gh` uses for a repository. */
export const nameWithOwner = (repoRef: GithubRepoRef): string => `${repoRef.owner}/${repoRef.name}`;

/** The GitHub owner and name from the `origin` URL, or null without a GitHub origin. */
export const originRepo = async (root: string): Promise<GithubRepoRef | null> => {
  const groups = GITHUB_URL.exec(await originUrl(root))?.groups;
  if (!groups) {
    return null;
  }
  return { name: groups.name, owner: groups.owner };
};

/** The default branch: `origin/HEAD`, else what GitHub reports, else the current branch when the repository has no GitHub origin. `offline` skips GitHub. */
export const defaultBranch = async (root: string, { offline = false }: { offline?: boolean } = {}): Promise<string> => {
  const head = await gitRun(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.status === 0) {
    return head.stdout.trim().slice('origin/'.length);
  }
  const repoRef = offline ? null : await originRepo(root);
  if (repoRef !== null) {
    const name = await must(['gh', 'repo', 'view', nameWithOwner(repoRef), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 'gh_failed');
    return name.trim();
  }
  const current = await gitMust(root, 'branch', '--show-current');
  return current.trim();
};

/** Reads `<owner>/<name>` from `text`, or gives null when `text` is not a valid `<owner>/<name>`. */
export const parseRepoRef = (text: string): GithubRepoRef | null => {
  const groups = NAME_WITH_OWNER.exec(text)?.groups;
  return groups ? { name: groups.name, owner: groups.owner } : null;
};

/** Reads the one `<owner/name>` positional of `command`, or throws `bad_args`. */
export const parseNameWithOwner = (command: string, positionals: string[]): GithubRepoRef => {
  const repoRef = positionals.length === 1 ? parseRepoRef(positionals[0]) : null;
  if (repoRef === null) {
    throw new CliError('bad_args', `${command} needs one <owner/name>`);
  }
  return repoRef;
};

/**
 * Gives the clone path `<cloneRoot>/<owner>/<name>` of `repoRef` and its {@link CloneSlot} state.
 * The path is a clone when it holds a checkout with `repoRef` as its `origin`. Anything else at the path is a conflict.
 */
export const cloneSlot = async (repoRef: GithubRepoRef, cloneRoot: string): Promise<CloneSlot> => {
  const root = path.join(cloneRoot, repoRef.owner, repoRef.name);
  if (!existsSync(root)) {
    return { conflict: false, present: false, root };
  }
  const origin = (await isCheckoutTop(root)) ? await originRepo(root) : null;
  const present = origin?.owner === repoRef.owner && origin.name === repoRef.name;
  return { conflict: !present, present, root };
};

/**
 * Gives the clone path `<cloneRoot>/<owner>/<name>` of `repoRef`, and if that path holds a clone of `repoRef`.
 * Throws `path_conflict` when the path holds something else.
 */
export const cloneDestination = async (repoRef: GithubRepoRef): Promise<{ root: string; present: boolean }> => {
  const { conflict, present, root } = await cloneSlot(repoRef, loadConfig().cloneRoot);
  if (conflict) {
    throw new CliError('path_conflict', `${root} exists and is not a clone of ${nameWithOwner(repoRef)}`, { path: root });
  }
  return { present, root };
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
