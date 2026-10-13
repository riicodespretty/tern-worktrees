import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { checkoutAt, gitMust, gitRun } from './git.ts';
import { CliError, must, run } from './proc.ts';
import type { RunOptions, RunResult } from './proc.ts';
import { nameWithOwner, parseGithubUrl, parseRepoRef, repoKey } from './repo-ref.ts';
import type { GithubRepoRef } from './repo-ref.ts';

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

/** The `origin` remote of a repository: `present` is false without one, and `github` is the GitHub owner and name of its URL, or null. */
export interface Origin {
  github: GithubRepoRef | null;
  present: boolean;
}

/** Reads the `origin` remote of the repository at `root` with one `git remote get-url origin`. */
export const readOrigin = async (root: string): Promise<Origin> => {
  const result = await gitRun(root, 'remote', 'get-url', 'origin');
  const url = result.stdout.trim();
  return { github: parseGithubUrl(url), present: url !== '' };
};

/** The default branch: `origin/HEAD`, else what GitHub reports for `repoRef`, else the current branch. When `repoRef` is null, it does not ask GitHub. */
export const defaultBranch = async (root: string, repoRef: GithubRepoRef | null): Promise<string> => {
  const head = await gitRun(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.status === 0) {
    return head.stdout.trim().slice('origin/'.length);
  }
  if (repoRef !== null) {
    const name = await ghMust('repo', 'view', nameWithOwner(repoRef), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
    return name.trim();
  }
  const current = await gitMust(root, 'branch', '--show-current');
  return current.trim();
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
 * The path is a clone when the `origin` of its checkout names the same GitHub repository as `repoRef`, by {@link repoKey}. Anything else at the path is a conflict.
 */
export const clonePath = async (repoRef: GithubRepoRef, cloneRoot: string): Promise<ClonePath> => {
  const root = path.join(cloneRoot, repoRef.owner, repoRef.name);
  if (!existsSync(root)) {
    return { root, state: null };
  }
  const checkout = await checkoutAt(root);
  const origin = checkout?.role === 'main' ? await readOrigin(root) : null;
  const originRef = origin?.github;
  const isClone = originRef ? repoKey(originRef) === repoKey(repoRef) : false;
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
