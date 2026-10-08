import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { gitMust, gitRun, isCheckoutTop, originUrl } from './git.ts';
import { CliError, must, run } from './proc.ts';
import type { RunOptions, RunResult } from './proc.ts';

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

/** The clone path of a GitHub repository. `state` is `'clone'` when the path holds a clone of the repository, `'conflict'` when the path holds something else, and null when nothing is at the path. */
export interface ClonePath {
  root: string;
  state: 'clone' | 'conflict' | null;
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

/** Runs `gh <args>`, waits for it to exit, and returns its exit status, standard output and standard error. It does not throw when gh fails. */
export const ghRun = async (...args: string[]): Promise<RunResult> => await run(['gh', ...args]);

/**
 * Runs `gh <args>` and gives its standard output as `stdout`.
 * Gives the standard error of gh, without the white space around it, as `error` when gh exits with a status other than 0. Otherwise `error` is null. It does not throw when gh fails.
 */
export const ghTry = async (...args: string[]): Promise<{ error: string | null; stdout: string }> => {
  const result = await ghRun(...args);
  return { error: result.status === 0 ? null : result.stderr.trim(), stdout: result.stdout };
};

/** Like {@link ghMust}, but runs gh with `opts`: the working directory and the env vars that gh gets. Pass `undefined` for the defaults. */
export const ghMustWith = async (opts: RunOptions | undefined, ...args: string[]): Promise<string> => await must(['gh', ...args], 'gh_failed', opts);

/** Runs `gh <args>` and returns its standard output. Throws `gh_failed` when gh exits with a status other than 0. */
export const ghMust = async (...args: string[]): Promise<string> => await ghMustWith(undefined, ...args);

/**
 * Lists the pull requests of `repoRef` that `filters` (`gh pr list` flags) select, with the `fields` of each.
 * Gives the error of {@link ghTry}, and no pull requests, when gh fails. Otherwise `error` is null.
 */
export const listPullRequests = async <Field extends keyof GhPullRequest>(
  repoRef: GithubRepoRef,
  filters: string[],
  fields: Field[],
): Promise<{ error: string | null; prs: Pick<GhPullRequest, Field>[] }> => {
  const { error, stdout } = await ghTry('pr', 'list', '--repo', nameWithOwner(repoRef), ...filters, '--json', fields.join(','));
  if (error !== null) {
    return { error, prs: [] };
  }
  // SAFETY: `gh pr list --json` prints an array of objects with the fields that its `--json` flag names.
  return { error: null, prs: JSON.parse(stdout) as Pick<GhPullRequest, Field>[] };
};

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
    const name = await ghMust('repo', 'view', nameWithOwner(repoRef), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
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
 * Gives the clone path `<cloneRoot>/<owner>/<name>` of `repoRef` and its {@link ClonePath} state.
 * The path is a clone when it holds a checkout with `repoRef` as its `origin`. Anything else at the path is a conflict.
 */
export const clonePath = async (repoRef: GithubRepoRef, cloneRoot: string): Promise<ClonePath> => {
  const root = path.join(cloneRoot, repoRef.owner, repoRef.name);
  if (!existsSync(root)) {
    return { root, state: null };
  }
  const origin = (await isCheckoutTop(root)) ? await originRepo(root) : null;
  const isClone = origin?.owner === repoRef.owner && origin.name === repoRef.name;
  return { root, state: isClone ? 'clone' : 'conflict' };
};

/**
 * Like {@link clonePath} with the clone root of the options file, but throws `path_conflict` when the path holds something else.
 * Its `state` is `'clone'` when the path holds a clone of `repoRef`, and null when nothing is at the path.
 */
export const cloneDestination = async (repoRef: GithubRepoRef): Promise<ClonePath & { state: 'clone' | null }> => {
  const found = await clonePath(repoRef, loadConfig().cloneRoot);
  if (found.state === 'conflict') {
    throw new CliError('path_conflict', `${found.root} exists and is not a clone of ${nameWithOwner(repoRef)}`, { path: found.root });
  }
  return { root: found.root, state: found.state };
};

/** Clones `repoRef` to `<cloneRoot>/<owner>/<name>`, or reuses the clone at that path. Throws `path_conflict` when the path holds something else. */
export const cloneRepo = async (repoRef: GithubRepoRef): Promise<GithubClone> => {
  const { root, state } = await cloneDestination(repoRef);
  if (state === 'clone') {
    return { cloned: false, root };
  }
  mkdirSync(path.dirname(root), { recursive: true });
  await ghMust('repo', 'clone', nameWithOwner(repoRef), root);
  return { cloned: true, root };
};
