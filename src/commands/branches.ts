import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultBranch, originSlug, repoRoot, worktrees } from '../git.ts';
import type { RepoSlug } from '../git.ts';
import { isUnder, worktreeRoot } from '../paths.ts';
import { CliError, must, run as runProcess } from '../proc.ts';

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

interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  isCrossRepository: boolean;
}

const REMOTE_PREFIX = 'refs/remotes/origin/';
const LOCAL_PREFIX = 'refs/heads/';

const listBranches = async (root: string, hasOrigin: boolean): Promise<string[]> => {
  const patterns = hasOrigin ? ['refs/remotes/origin', 'refs/heads'] : ['refs/heads'];
  const output = await must(['git', '-C', root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', ...patterns], 'git_failed');
  const names = output
    .split('\n')
    .filter(ref => ref !== '')
    .map(ref => (ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : ref.slice(LOCAL_PREFIX.length)))
    .filter(name => name !== 'HEAD');
  return [...new Set(names)];
};

const listPullRequests = async (slug: RepoSlug, warnings: string[]): Promise<PullRequest[]> => {
  const argv = ['gh', 'pr', 'list', '--repo', `${slug.owner}/${slug.name}`, '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,isCrossRepository'];
  const result = await runProcess(argv);
  if (result.status !== 0) {
    warnings.push(`pr list failed: ${result.stderr.trim()}`);
    return [];
  }
  // SAFETY: `gh pr list --json` prints an array with the fields it names.
  const prs = JSON.parse(result.stdout) as GhPullRequest[];
  return prs.map(pr => ({ branch: pr.headRefName, fork: pr.isCrossRepository, number: pr.number, title: pr.title }));
};

/** `branches --repo <dir> [--offline]`: the branches, open pull requests and worktrees of the repository that holds `dir`. `--offline` reads only local refs: no fetch and no pull requests. */
export const run = async (args: string[]): Promise<BranchesResult> => {
  const { values } = parseArgs({ args, options: { offline: { default: false, type: 'boolean' }, repo: { type: 'string' } } });
  if (values.repo === undefined) {
    throw new CliError('bad_args', 'branches needs --repo <dir>');
  }
  const root = await repoRoot(values.repo);
  if (root === null) {
    throw new CliError('not_a_repo', `${values.repo} is not in a git repository`);
  }
  const { offline } = values;
  const warnings: string[] = [];
  const originUrl = await runProcess(['git', '-C', root, 'remote', 'get-url', 'origin']);
  const hasOrigin = originUrl.status === 0;
  if (hasOrigin && !offline) {
    const fetchResult = await runProcess(['git', '-C', root, 'fetch', '--prune', 'origin']);
    if (fetchResult.status !== 0) {
      warnings.push(`fetch failed: ${fetchResult.stderr.trim()}`);
    }
  }
  const slug = offline ? null : await originSlug(root);
  const [branches, prs, repoWorktrees, defaultName] = await Promise.all([
    listBranches(root, hasOrigin),
    slug === null ? [] : listPullRequests(slug, warnings),
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
