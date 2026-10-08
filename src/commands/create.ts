import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchOrigin, gitMust, gitRun, gitSucceeds, hardToRebuild, hasOrigin, requireRepoRoot, worktreeLosses, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { defaultBranch, nameWithOwner, originRepo } from '../github.ts';
import type { GhPullRequest } from '../github.ts';
import { isUnder, worktreePath } from '../paths.ts';
import { CliError, must } from '../proc.ts';
import { blocksUnder, focus, newSession, newTab, rename, sessionForRepo } from '../tern.ts';

/** How `create` got the worktree. */
export type CreateStatus = 'created' | 'relocated' | 'reused';

/** The Tern tab that shows the worktree. */
export interface CreatedTab {
  block: number;
  opened: boolean;
  session: string;
}

/** The output of `create`. `carried` lists the ignored files that a relocation copied into the rebuilt worktree, and is empty otherwise. */
export interface CreateResult {
  branch: string;
  carried: string[];
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

interface Carry {
  files: string[];
  staging: string;
}

interface Context {
  carry: Carry | null;
  repoName: string;
  root: string;
  warnings: string[];
  withOrigin: boolean;
}

interface Target {
  branch: string;
  forkPr: string | null;
  path: string;
}

interface Placement {
  isNew: boolean;
  relocate: boolean;
}

type Source = { branch: string; isNew: boolean } | { pr: string };

interface CheckedOptions {
  repo: string;
  source: Source;
}

const badArgs = (message: string): CliError => new CliError('bad_args', message);

const parse = (args: string[]): Options =>
  parseArgs({
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

const checkOptions = (options: Options): CheckedOptions => {
  const { branch, pr, repo } = options;
  if (repo === undefined) {
    throw badArgs('--repo is required');
  }
  if (pr === undefined) {
    if (branch === undefined) {
      throw badArgs('pass one of --branch or --pr');
    }
    return { repo, source: { branch, isNew: options.new } };
  }
  if (branch !== undefined) {
    throw badArgs('pass one of --branch or --pr');
  }
  if (options.new) {
    throw badArgs('--new does not apply to --pr');
  }
  if (!/^[1-9]\d*$/u.test(pr)) {
    throw badArgs(`bad pull request number ${pr}`);
  }
  return { repo, source: { pr } };
};

const pullRequestTarget = async (ctx: Context, pr: string): Promise<Target> => {
  const repoRef = await originRepo(ctx.root);
  if (repoRef === null) {
    throw badArgs('--pr needs a GitHub origin');
  }
  const view = await must(['gh', 'pr', 'view', pr, '--repo', nameWithOwner(repoRef), '--json', 'number,headRefName,isCrossRepository'], 'gh_failed');
  // SAFETY: `gh pr view --json` prints the fields that its `--json` flag names.
  const { headRefName, isCrossRepository } = JSON.parse(view) as Pick<GhPullRequest, 'headRefName' | 'isCrossRepository'>;
  if (isCrossRepository) {
    const branch = `pr-${pr}`;
    return { branch, forkPr: pr, path: worktreePath(ctx.repoName, branch) };
  }
  return { branch: headRefName, forkPr: null, path: worktreePath(ctx.repoName, headRefName) };
};

const sourceTarget = async (ctx: Context, source: Source): Promise<{ isNew: boolean; target: Target }> => {
  if ('branch' in source) {
    return { isNew: source.isNew, target: { branch: source.branch, forkPr: null, path: worktreePath(ctx.repoName, source.branch) } };
  }
  return { isNew: false, target: await pullRequestTarget(ctx, source.pr) };
};

const startPoint = async (ctx: Context): Promise<string> => {
  const name = await defaultBranch(ctx.root);
  return ctx.withOrigin ? `origin/${name}` : name;
};

const hasRef = async (ctx: Context, ref: string): Promise<boolean> => await gitSucceeds(ctx.root, 'rev-parse', '--verify', '--quiet', ref);

const checkBranch = async (ctx: Context, target: Target, isNew: boolean): Promise<void> => {
  if (!(await gitSucceeds(ctx.root, 'check-ref-format', '--branch', target.branch))) {
    throw badArgs(`bad branch name ${target.branch}`);
  }
  if (isNew && ((await hasRef(ctx, `refs/heads/${target.branch}`)) || (await hasRef(ctx, `refs/remotes/origin/${target.branch}`)))) {
    throw badArgs(`branch ${target.branch} already exists`);
  }
};

const worktreeAddArgs = async (ctx: Context, target: Target, isNew: boolean): Promise<string[]> => {
  if (isNew) {
    return ['-b', target.branch, '--', target.path, await startPoint(ctx)];
  }
  if (await hasRef(ctx, `refs/heads/${target.branch}`)) {
    return ['--', target.path, target.branch];
  }
  if (await hasRef(ctx, `refs/remotes/origin/${target.branch}`)) {
    return ['--track', '-b', target.branch, '--', target.path, `origin/${target.branch}`];
  }
  throw badArgs(`no branch ${target.branch}; pass --new to create it`);
};

const assertPathFree = (target: Target): void => {
  if (lstatSync(target.path, { throwIfNoEntry: false })) {
    throw new CliError('path_conflict', `${target.path} exists and is not the worktree of ${target.branch}`, { path: target.path });
  }
};

const addWorktree = async (ctx: Context, target: Target, isNew: boolean): Promise<void> => {
  assertPathFree(target);
  if (target.forkPr === null) {
    await gitMust(ctx.root, 'worktree', 'add', ...(await worktreeAddArgs(ctx, target, isNew)));
    return;
  }
  await gitMust(ctx.root, 'worktree', 'add', '--detach', '--', target.path, await startPoint(ctx));
  try {
    await must(['gh', 'pr', 'checkout', target.forkPr, '--branch', target.branch], 'gh_failed', { cwd: target.path });
  } catch (error) {
    await gitMust(ctx.root, 'worktree', 'remove', '--force', target.path);
    throw error;
  }
};

const copyEntry = (from: string, to: string): void => {
  mkdirSync(path.dirname(to), { recursive: true });
  if (lstatSync(from).isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    return;
  }
  copyFileSync(from, to);
};

const stage = (ctx: Context, dir: string, files: string[]): void => {
  const staging = mkdtempSync(path.join(tmpdir(), 'tern-wt-carry-'));
  ctx.carry = { files, staging };
  for (const file of files) {
    copyEntry(path.join(dir, file), path.join(staging, file));
  }
};

const unstage = (ctx: Context, carry: Carry, dir: string): string[] => {
  const carried: string[] = [];
  for (const file of carry.files) {
    const to = path.join(dir, file);
    if (lstatSync(to, { throwIfNoEntry: false })) {
      ctx.warnings.push(`not carried: ${file} exists in the new worktree; the old copy stays in ${carry.staging}`);
      continue;
    }
    copyEntry(path.join(carry.staging, file), to);
    carried.push(file);
  }
  if (carried.length === carry.files.length) {
    rmSync(carry.staging, { recursive: true });
  }
  return carried;
};

const withStaging = (error: Error, staging: string): CliError => {
  const [code, extra] = error instanceof CliError ? [error.code, error.extra] : (['git_failed', {}] as const);
  return new CliError(code, `${error.message}; the carried files stay in ${staging}`, { ...extra, staging });
};

const moveOrClear = async (ctx: Context, target: Target, existing: Worktree): Promise<string | null> => {
  const moved = await gitRun(ctx.root, 'worktree', 'move', existing.path, target.path);
  if (moved.status === 0) {
    return null;
  }
  const files = await worktreeLosses(existing.path);
  if (files.length > 0) {
    throw new CliError('dirty_worktree', `${existing.path} has work that recreating it would lose`, { existing: existing.path, files });
  }
  stage(ctx, existing.path, await hardToRebuild(existing.path));
  await gitMust(ctx.root, 'worktree', 'remove', '--force', '--force', existing.path);
  const [reason] = moved.stderr.split('\n');
  return reason;
};

const relocate = async (ctx: Context, target: Target, existing: Worktree): Promise<void> => {
  assertPathFree(target);
  mkdirSync(path.dirname(target.path), { recursive: true });
  const lockReason = existing.locked;
  if (lockReason !== null) {
    await gitMust(ctx.root, 'worktree', 'unlock', existing.path);
  }
  let refusal: string | null;
  try {
    refusal = await moveOrClear(ctx, target, existing);
  } catch (error) {
    if (lockReason !== null) {
      await gitMust(ctx.root, 'worktree', 'lock', '--reason', lockReason, existing.path);
    }
    throw error;
  }
  if (refusal !== null) {
    await addWorktree(ctx, target, false);
    ctx.warnings.push(`recreated: git worktree move refused (${refusal})`);
  }
};

const placeWorktree = async (ctx: Context, target: Target, placement: Placement): Promise<CreateStatus> => {
  await checkBranch(ctx, target, placement.isNew);
  const listed = await worktrees(ctx.root);
  const existing = listed.find(worktree => worktree.branch === target.branch);
  if (existing?.prunable === true) {
    await gitMust(ctx.root, 'worktree', 'remove', existing.path);
  }
  if (!existing || existing.prunable) {
    await addWorktree(ctx, target, placement.isNew);
    return 'created';
  }
  const samePath = isUnder(existing.path, target.path) && isUnder(target.path, existing.path);
  if (samePath) {
    return 'reused';
  }
  if (existing.main) {
    throw new CliError('branch_in_main_checkout', `${target.branch} is checked out in the main checkout at ${existing.path}`, { existing: existing.path });
  }
  if (!placement.relocate) {
    throw new CliError('worktree_exists_elsewhere', `${target.branch} has a worktree at ${existing.path}; pass --relocate to move it to ${target.path}`, {
      existing: existing.path,
      target: target.path,
    });
  }
  await relocate(ctx, target, existing);
  return 'relocated';
};

const updateSubmodules = async (ctx: Context, dir: string): Promise<void> => {
  const result = await gitRun(dir, 'submodule', 'update', '--init', '--recursive');
  if (result.status !== 0) {
    ctx.warnings.push(`submodule update failed: ${result.stderr.trim()}`);
  }
};

const openTab = async (ctx: Context, target: Target): Promise<CreatedTab> => {
  const blocks = await blocksUnder(target.path);
  const existingBlock = blocks.at(0);
  if (existingBlock) {
    await focus(existingBlock.block.id);
    return { block: existingBlock.block.id, opened: false, session: existingBlock.session.name };
  }
  const session = await sessionForRepo(ctx.root);
  const block = session === null ? await newSession(ctx.repoName, target.path) : await newTab(session.name, target.path);
  await rename(block, target.branch);
  return { block, opened: true, session: session?.name ?? ctx.repoName };
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
  const { repo, source } = checkOptions(options);
  const root = await requireRepoRoot(repo);
  const ctx: Context = { carry: null, repoName: path.basename(root), root, warnings: [], withOrigin: await hasOrigin(root) };
  if (ctx.withOrigin) {
    const fetchWarning = await fetchOrigin(root, true);
    if (fetchWarning !== null) {
      ctx.warnings.push(fetchWarning);
    }
  }
  const { isNew, target } = await sourceTarget(ctx, source);
  let status: CreateStatus;
  let carried: string[] = [];
  try {
    status = await placeWorktree(ctx, target, { isNew, relocate: options.relocate });
    if (status !== 'reused') {
      await updateSubmodules(ctx, target.path);
    }
    if (ctx.carry !== null) {
      carried = unstage(ctx, ctx.carry, target.path);
    }
  } catch (error) {
    if (ctx.carry === null) {
      throw error;
    }
    // SAFETY: the steps after staging throw a CliError, or an Error from node:fs.
    throw withStaging(error as Error, ctx.carry.staging);
  }
  const tab = options['no-tab'] ? null : await tryOpenTab(ctx, target);
  return { branch: target.branch, carried, path: target.path, repo: root, status, tab, warnings: ctx.warnings };
};
