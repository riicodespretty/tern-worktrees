import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchOrigin, gitMust, requireRepoRoot, worktrees } from '../git.ts';
import { defaultBranch, listPullRequests, readOrigin } from '../github.ts';
import { worktreeOwner, worktreeRoot } from '../paths.ts';
import type { WorktreeOwner } from '../paths.ts';
import { CliError } from '../proc.ts';
import type { GithubRepoRef } from '../repo-ref.ts';

/** An open pull request of the repository. */
export interface PullRequest {
  number: number;
  title: string;
  branch: string;
  fork: boolean;
}

/**
 * A worktree of the repository. `owner` tells who owns it: `tern` for a tern-managed worktree, `<root>/<repo>/<slug>`, `omp` for an omp-owned one,
 * elsewhere in the omp worktree root, and null for a worktree that is not in the worktree root. `managed` is true for a tern-managed worktree.
 * `main` is true for the main checkout.
 */
export interface BranchWorktree {
  branch: string | null;
  path: string;
  main: boolean;
  managed: boolean;
  owner: WorktreeOwner;
}

/** The branch picker data of a repository. `prsFailed` is true when `gh pr list` failed, and false offline and when `origin` is not a GitHub repository. */
export interface BranchesResult {
  repo: string;
  name: string;
  default: string;
  branches: string[];
  prs: PullRequest[];
  prsFailed: boolean;
  worktrees: BranchWorktree[];
  warnings: string[];
}

/** The open pull requests. `failed` is true when `gh pr list` failed. */
interface OpenPullRequests {
  failed: boolean;
  prs: PullRequest[];
}

const REMOTE_PREFIX = 'refs/remotes/origin/';
const LOCAL_PREFIX = 'refs/heads/';

const listBranches = async (root: string, withOrigin: boolean): Promise<string[]> => {
  const patterns = withOrigin ? ['refs/remotes/origin', 'refs/heads'] : ['refs/heads'];
  const output = await gitMust(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', ...patterns);
  const names = output
    .split('\n')
    .filter(ref => ref !== '')
    .map(ref => (ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : ref.slice(LOCAL_PREFIX.length)))
    .filter(name => name !== 'HEAD');
  return [...new Set(names)];
};

const openPullRequests = async (repoRef: GithubRepoRef, warnings: string[]): Promise<OpenPullRequests> => {
  const { error, prs } = await listPullRequests(repoRef, ['--state', 'open', '--limit', '200'], ['number', 'title', 'headRefName', 'isCrossRepository']);
  if (error !== null) {
    warnings.push(`pr list failed: ${error}`);
  }
  return { failed: error !== null, prs: prs.map(pr => ({ branch: pr.headRefName, fork: pr.isCrossRepository, number: pr.number, title: pr.title })) };
};

/** `branches --repo <dir> [--offline]`: the branches, open pull requests and worktrees of the repository that holds `dir`. `--offline` reads only local refs: no fetch and no pull requests. */
export const run = async (args: string[]): Promise<BranchesResult> => {
  const { values } = parseArgs({ args, options: { offline: { default: false, type: 'boolean' }, repo: { type: 'string' } } });
  if (values.repo === undefined) {
    throw new CliError('bad_args', 'branches needs --repo <dir>');
  }
  const root = await requireRepoRoot(values.repo);
  const { offline } = values;
  const warnings: string[] = [];
  const origin = await readOrigin(root);
  if (origin.present && !offline) {
    const fetchWarning = await fetchOrigin(root, true);
    if (fetchWarning !== null) {
      warnings.push(fetchWarning);
    }
  }
  const github = offline ? null : origin.github;
  const [branches, pullRequests, repoWorktrees, defaultName, wtRoot] = await Promise.all([
    listBranches(root, origin.present),
    github === null ? { failed: false, prs: [] } : openPullRequests(github, warnings),
    worktrees(root),
    defaultBranch(root, github),
    worktreeRoot(),
  ]);
  return {
    branches,
    default: defaultName,
    name: path.basename(root),
    prs: pullRequests.prs,
    prsFailed: pullRequests.failed,
    repo: root,
    warnings,
    worktrees: repoWorktrees.map(worktree => {
      const owner = worktreeOwner(wtRoot, root, worktree.path);
      return { branch: worktree.branch, main: worktree.main, managed: owner === 'tern', owner, path: worktree.path };
    }),
  };
};
