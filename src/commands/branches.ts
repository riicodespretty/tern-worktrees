import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchOrigin, gitMust, hasOrigin, requireRepoRoot, worktrees } from '../git.ts';
import { defaultBranch, nameWithOwner, originRepo } from '../github.ts';
import type { GhPullRequest, GithubRepoRef } from '../github.ts';
import { isUnder, worktreeRoot } from '../paths.ts';
import { CliError, run as runProcess } from '../proc.ts';

/** An open pull request of the repository. */
export interface PullRequest {
  number: number;
  title: string;
  branch: string;
  fork: boolean;
}

/** A worktree of the repository. `managed` tells if the worktree is in the worktree root. */
export interface BranchWorktree {
  branch: string | null;
  path: string;
  managed: boolean;
}

/** The branch picker data of a repository. */
export interface BranchesResult {
  repo: string;
  name: string;
  default: string;
  branches: string[];
  prs: PullRequest[];
  worktrees: BranchWorktree[];
  warnings: string[];
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

const listPullRequests = async (repoRef: GithubRepoRef, warnings: string[]): Promise<PullRequest[]> => {
  const argv = ['gh', 'pr', 'list', '--repo', nameWithOwner(repoRef), '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,isCrossRepository'];
  const result = await runProcess(argv);
  if (result.status !== 0) {
    warnings.push(`pr list failed: ${result.stderr.trim()}`);
    return [];
  }
  // SAFETY: `gh pr list --json` prints an array with the fields it names.
  const prs = JSON.parse(result.stdout) as Pick<GhPullRequest, 'headRefName' | 'isCrossRepository' | 'number' | 'title'>[];
  return prs.map(pr => ({ branch: pr.headRefName, fork: pr.isCrossRepository, number: pr.number, title: pr.title }));
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
  const withOrigin = await hasOrigin(root);
  if (withOrigin && !offline) {
    const fetchWarning = await fetchOrigin(root, true);
    if (fetchWarning !== null) {
      warnings.push(fetchWarning);
    }
  }
  const repoRef = offline ? null : await originRepo(root);
  const [branches, prs, repoWorktrees, defaultName] = await Promise.all([
    listBranches(root, withOrigin),
    repoRef === null ? [] : listPullRequests(repoRef, warnings),
    worktrees(root),
    defaultBranch(root, { offline }),
  ]);
  const worktreeRootDir = worktreeRoot();
  return {
    branches,
    default: defaultName,
    name: path.basename(root),
    prs,
    repo: root,
    warnings,
    worktrees: repoWorktrees.map(worktree => ({ branch: worktree.branch, managed: isUnder(worktree.path, worktreeRootDir), path: worktree.path })),
  };
};
