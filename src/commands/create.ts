import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultBranch, dirtyFiles, originSlug, repoRoot, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { isUnder, worktreePath } from '../paths.ts';
import { CliError, must, run as runProcess } from '../proc.ts';
import { blocksUnder, focus, newSession, newTab, rename, sessionForRepo } from '../tern.ts';

/** How `create` got the worktree. */
export type CreateStatus = 'created' | 'relocated' | 'reused';

/** The Tern tab that shows the worktree. */
export interface CreatedTab {
  block: number;
  opened: boolean;
  session: string;
}

/** The output of `create`. */
export interface CreateResult {
  branch: string;
  path: string;
  repo: string;
  status: CreateStatus;
  tab: CreatedTab | null;
  warnings: string[];
}

interface Options {
  'branch'?: string;
  'new': boolean;
  'no-tab': boolean;
  'pr'?: string;
  'relocate': boolean;
  'repo'?: string;
}

interface Context {
  hasOrigin: boolean;
  name: string;
  root: string;
  warnings: string[];
}

interface Target {
  branch: string;
  fork: string | null;
  path: string;
}

interface PullRequest {
  headRefName: string;
  isCrossRepository: boolean;
}

const badArgs = (message: string): CliError => new CliError('bad_args', message);

const parse = (args: string[]): Options => {
  try {
    return parseArgs({
      args,
      options: {
        'branch': { type: 'string' },
        'new': { default: false, type: 'boolean' },
        'no-tab': { default: false, type: 'boolean' },
        'pr': { type: 'string' },
        'relocate': { default: false, type: 'boolean' },
        'repo': { type: 'string' },
      },
    }).values;
  } catch (error) {
    // SAFETY: `parseArgs` throws a TypeError for each bad argument.
    throw badArgs((error as TypeError).message);
  }
};

const checkOptions = (options: Options): string => {
  if (options.repo === undefined) {
    throw badArgs('--repo is required');
  }
  if ((options.branch === undefined) === (options.pr === undefined)) {
    throw badArgs('pass one of --branch or --pr');
  }
  if (options.pr !== undefined && options.new) {
    throw badArgs('--new does not apply to --pr');
  }
  if (options.pr !== undefined && !/^[1-9]\d*$/u.test(options.pr)) {
    throw badArgs(`bad pull request number ${options.pr}`);
  }
  return options.repo;
};

const git = async (root: string, ...args: string[]): Promise<string> => await must(['git', '-C', root, ...args], 'git_failed');

const gitOk = async (root: string, ...args: string[]): Promise<boolean> => {
  const result = await runProcess(['git', '-C', root, ...args]);
  return result.status === 0;
};

const fetchOrigin = async (ctx: Context): Promise<void> => {
  if (!ctx.hasOrigin) {
    return;
  }
  const result = await runProcess(['git', '-C', ctx.root, 'fetch', '--prune', 'origin']);
  if (result.status !== 0) {
    ctx.warnings.push(`fetch failed: ${result.stderr.trim()}`);
  }
};

const pullRequestTarget = async (ctx: Context, pr: string): Promise<Target> => {
  const slug = await originSlug(ctx.root);
  if (slug === null) {
    throw badArgs('--pr needs a GitHub origin');
  }
  const view = await must(['gh', 'pr', 'view', pr, '--repo', `${slug.owner}/${slug.name}`, '--json', 'number,headRefName,isCrossRepository'], 'gh_failed');
  // SAFETY: `gh pr view --json` prints the fields it was asked for.
  const { headRefName, isCrossRepository } = JSON.parse(view) as PullRequest;
  if (isCrossRepository) {
    const branch = `pr-${pr}`;
    return { branch, fork: pr, path: worktreePath(ctx.name, branch) };
  }
  return { branch: headRefName, fork: null, path: worktreePath(ctx.name, headRefName) };
};

const startPoint = async (ctx: Context): Promise<string> => {
  const name = await defaultBranch(ctx.root);
  return ctx.hasOrigin ? `origin/${name}` : name;
};

const addArgs = async (ctx: Context, target: Target, isNew: boolean): Promise<string[]> => {
  const local = await gitOk(ctx.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`);
  const remote = await gitOk(ctx.root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target.branch}`);
  if (isNew) {
    if (local || remote) {
      throw badArgs(`branch ${target.branch} already exists`);
    }
    return ['-b', target.branch, target.path, await startPoint(ctx)];
  }
  if (local) {
    return [target.path, target.branch];
  }
  if (remote) {
    return ['--track', '-b', target.branch, target.path, `origin/${target.branch}`];
  }
  throw badArgs(`no branch ${target.branch}; pass --new to create it`);
};

const checkFree = (target: Target): void => {
  if (existsSync(target.path)) {
    throw new CliError('path_conflict', `${target.path} exists and is not the worktree of ${target.branch}`, { path: target.path });
  }
};

const addWorktree = async (ctx: Context, target: Target, isNew: boolean): Promise<void> => {
  checkFree(target);
  if (target.fork === null) {
    await git(ctx.root, 'worktree', 'add', ...(await addArgs(ctx, target, isNew)));
    return;
  }
  await git(ctx.root, 'worktree', 'add', '--detach', target.path, await startPoint(ctx));
  await must(['gh', 'pr', 'checkout', target.fork, '--branch', target.branch], 'gh_failed', { cwd: target.path });
};

const relocate = async (ctx: Context, target: Target, existing: Worktree): Promise<void> => {
  checkFree(target);
  if (existing.locked) {
    await git(ctx.root, 'worktree', 'unlock', existing.path);
  }
  mkdirSync(path.dirname(target.path), { recursive: true });
  const moved = await runProcess(['git', '-C', ctx.root, 'worktree', 'move', existing.path, target.path]);
  if (moved.status === 0) {
    return;
  }
  const files = await dirtyFiles(existing.path);
  if (files.length > 0) {
    throw new CliError('dirty_worktree', `${existing.path} has uncommitted changes`, { existing: existing.path, files });
  }
  await git(ctx.root, 'worktree', 'remove', '--force', '--force', existing.path);
  await addWorktree(ctx, target, false);
  const [reason] = moved.stderr.split('\n');
  ctx.warnings.push(`recreated: git worktree move refused (${reason})`);
};

const place = async (ctx: Context, target: Target, options: Options): Promise<CreateStatus> => {
  const listed = await worktrees(ctx.root);
  const existing = listed.find(worktree => worktree.branch === target.branch);
  if (!existing) {
    await addWorktree(ctx, target, options.new);
    return 'created';
  }
  if (isUnder(existing.path, target.path) && isUnder(target.path, existing.path)) {
    return 'reused';
  }
  if (existing.main) {
    throw new CliError('branch_in_main_checkout', `${target.branch} is checked out in the main checkout at ${existing.path}`, { existing: existing.path });
  }
  if (!options.relocate) {
    throw new CliError('worktree_exists_elsewhere', `${target.branch} has a worktree at ${existing.path}; pass --relocate to move it to ${target.path}`, {
      existing: existing.path,
      target: target.path,
    });
  }
  await relocate(ctx, target, existing);
  return 'relocated';
};

const updateSubmodules = async (ctx: Context, dir: string): Promise<void> => {
  const result = await runProcess(['git', '-C', dir, 'submodule', 'update', '--init', '--recursive']);
  if (result.status !== 0) {
    ctx.warnings.push(`submodule update failed: ${result.stderr.trim()}`);
  }
};

const openTab = async (ctx: Context, target: Target): Promise<CreatedTab> => {
  const blocks = await blocksUnder(target.path);
  const shown = blocks.at(0);
  if (shown) {
    await focus(shown.block.id);
    return { block: shown.block.id, opened: false, session: shown.session.name };
  }
  const session = await sessionForRepo(ctx.root);
  const block = session === null ? await newSession(ctx.name, target.path) : await newTab(session.name, target.path);
  await rename(block, target.branch);
  return { block, opened: true, session: session?.name ?? ctx.name };
};

const tryOpenTab = async (ctx: Context, target: Target): Promise<CreatedTab | null> => {
  try {
    return await openTab(ctx, target);
  } catch (error) {
    if (error instanceof CliError) {
      ctx.warnings.push(`tab not opened: ${error.message}`);
      return null;
    }
    throw error;
  }
};

/**
 * `create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`:
 * creates or reuses the managed worktree of a branch or pull request, and opens or focuses its Tern tab.
 */
export const run = async (args: string[]): Promise<CreateResult> => {
  const options = parse(args);
  const repo = checkOptions(options);
  const root = await repoRoot(repo);
  if (root === null) {
    throw new CliError('not_a_repo', `${repo} is not in a git repository`);
  }
  const ctx: Context = { hasOrigin: await gitOk(root, 'remote', 'get-url', 'origin'), name: path.basename(root), root, warnings: [] };
  await fetchOrigin(ctx);
  const target =
    options.branch === undefined ? await pullRequestTarget(ctx, String(options.pr)) : { branch: options.branch, fork: null, path: worktreePath(ctx.name, options.branch) };
  const status = await place(ctx, target, options);
  if (status !== 'reused') {
    await updateSubmodules(ctx, target.path);
  }
  const tab = options['no-tab'] ? null : await tryOpenTab(ctx, target);
  return { branch: target.branch, path: target.path, repo: root, status, tab, warnings: ctx.warnings };
};
