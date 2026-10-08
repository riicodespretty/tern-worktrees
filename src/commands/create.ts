import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchOrigin, gitMust, gitRun, gitSucceeds, hardToRebuild, hasOrigin, requireRepoRoot, worktreeLosses, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { defaultBranch, ghMust, ghMustWith, nameWithOwner, originRepo } from '../github.ts';
import type { GhPullRequest } from '../github.ts';
import { ompSettings, ompWorktreeAdd } from '../omp.ts';
import { isUnder, worktreeOwner, worktreePath, worktreeRoot } from '../paths.ts';
import type { WorktreeRoot } from '../paths.ts';
import { CliError } from '../proc.ts';
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

/** `clone` is the omp binary when omp clone mode makes the worktrees, else null. */
interface Context {
  carry: Carry | null;
  clone: string | null;
  repoName: string;
  root: string;
  warnings: string[];
  withOrigin: boolean;
  wtRoot: WorktreeRoot;
}

/** `ompPrBranch` is `pr-<n>`, the branch of the omp checkout of a same-repository pull request, else null. */
interface Target {
  branch: string;
  forkPr: string | null;
  ompPrBranch: string | null;
  path: string;
}

interface Placement {
  isNew: boolean;
  relocate: boolean;
}

interface Placed {
  branch: string;
  path: string;
  status: CreateStatus;
}

/** How to add a worktree: at `start`, detached or on `newBranch` when it is set, with `origin/<newBranch>` as upstream when `track` is true. */
interface AddSpec {
  detach: boolean;
  newBranch: string | null;
  start: string;
  track: boolean;
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
  const view = await ghMust('pr', 'view', pr, '--repo', nameWithOwner(repoRef), '--json', 'number,headRefName,isCrossRepository');
  // SAFETY: `gh pr view --json` prints the fields that its `--json` flag names.
  const { headRefName, isCrossRepository } = JSON.parse(view) as Pick<GhPullRequest, 'headRefName' | 'isCrossRepository'>;
  if (isCrossRepository) {
    const branch = `pr-${pr}`;
    return { branch, forkPr: pr, ompPrBranch: null, path: worktreePath(ctx.wtRoot, ctx.repoName, branch) };
  }
  return { branch: headRefName, forkPr: null, ompPrBranch: `pr-${pr}`, path: worktreePath(ctx.wtRoot, ctx.repoName, headRefName) };
};

const sourceTarget = async (ctx: Context, source: Source): Promise<{ isNew: boolean; target: Target }> => {
  if ('branch' in source) {
    const target = { branch: source.branch, forkPr: null, ompPrBranch: null, path: worktreePath(ctx.wtRoot, ctx.repoName, source.branch) };
    return { isNew: source.isNew, target };
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

const addSpec = async (ctx: Context, target: Target, isNew: boolean): Promise<AddSpec> => {
  if (target.forkPr !== null) {
    return { detach: true, newBranch: null, start: await startPoint(ctx), track: false };
  }
  if (isNew) {
    return { detach: false, newBranch: target.branch, start: await startPoint(ctx), track: false };
  }
  if (await hasRef(ctx, `refs/heads/${target.branch}`)) {
    return { detach: false, newBranch: null, start: target.branch, track: false };
  }
  if (await hasRef(ctx, `refs/remotes/origin/${target.branch}`)) {
    return { detach: false, newBranch: target.branch, start: `origin/${target.branch}`, track: true };
  }
  throw badArgs(`no branch ${target.branch}; pass --new to create it`);
};

const addArgs = (spec: AddSpec): string[] => [...(spec.detach ? ['--detach'] : []), ...(spec.newBranch === null ? [] : ['-b', spec.newBranch])];

/**
 * Adds the worktree with `omp worktree add` when `clone` is the omp binary, else with `git worktree add`. omp sets no upstream, so in clone mode
 * `git branch` makes a new branch first: it sets the same upstream as `git worktree add -b`, and omp then checks out that branch.
 */
const addWith = async (ctx: Context, clone: string | null, target: Target, spec: AddSpec): Promise<void> => {
  if (clone === null) {
    await gitMust(ctx.root, 'worktree', 'add', ...(spec.track ? ['--track'] : []), ...addArgs(spec), '--', target.path, spec.start);
    return;
  }
  if (spec.newBranch === null) {
    ctx.warnings.push(...(await ompWorktreeAdd(clone, ctx.root, [...addArgs(spec), target.path, spec.start])));
    return;
  }
  await gitMust(ctx.root, 'branch', ...(spec.track ? ['--track'] : []), spec.newBranch, spec.start);
  try {
    ctx.warnings.push(...(await ompWorktreeAdd(clone, ctx.root, [target.path, spec.newBranch])));
  } catch (error) {
    await gitMust(ctx.root, 'branch', '-D', spec.newBranch);
    throw error;
  }
};

const assertPathFree = (target: Target): void => {
  if (lstatSync(target.path, { throwIfNoEntry: false })) {
    throw new CliError('path_conflict', `${target.path} exists and is not the worktree of ${target.branch}`, { path: target.path });
  }
};

/** Adds the worktree of `target`, through omp when `clone` is the omp binary. A fork pull request gets a detached worktree, then `gh pr checkout`. */
const addWorktree = async (ctx: Context, target: Target, isNew: boolean, clone: string | null): Promise<void> => {
  assertPathFree(target);
  await addWith(ctx, clone, target, await addSpec(ctx, target, isNew));
  if (target.forkPr === null) {
    return;
  }
  try {
    await ghMustWith({ cwd: target.path }, 'pr', 'checkout', target.forkPr, '--branch', target.branch);
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
    await addWorktree(ctx, target, false, null);
    ctx.warnings.push(`recreated: git worktree move refused (${refusal})`);
  }
};

/**
 * Reuses the omp checkout of the same-repository pull request of `target`: an omp-owned worktree on branch `pr-<n>`, when the `ompPrHeadRef`
 * that omp records in the git config of that branch is the head branch of the pull request, or when that key is not set. Null when there is none.
 */
const reuseOmpPrCheckout = async (ctx: Context, target: Target, listed: Worktree[]): Promise<Placed | null> => {
  const branch = target.ompPrBranch;
  const found = listed.find(worktree => worktree.branch === branch && !worktree.prunable && worktreeOwner(ctx.wtRoot, ctx.root, worktree.path) === 'omp');
  if (branch === null || !found) {
    return null;
  }
  const headRef = await gitRun(ctx.root, 'config', '--get', `branch.${branch}.ompPrHeadRef`);
  return headRef.status !== 0 || headRef.stdout.trim() === target.branch ? { branch, path: found.path, status: 'reused' } : null;
};

const placeWorktree = async (ctx: Context, target: Target, placement: Placement): Promise<Placed> => {
  await checkBranch(ctx, target, placement.isNew);
  const listed = await worktrees(ctx.root);
  const existing = listed.find(worktree => worktree.branch === target.branch);
  if (existing?.prunable === true) {
    await gitMust(ctx.root, 'worktree', 'remove', existing.path);
  }
  if (!existing || existing.prunable) {
    const reused = await reuseOmpPrCheckout(ctx, target, listed);
    if (reused) {
      return reused;
    }
    await addWorktree(ctx, target, placement.isNew, ctx.clone);
    return { branch: target.branch, path: target.path, status: 'created' };
  }
  const samePath = isUnder(existing.path, target.path) && isUnder(target.path, existing.path);
  if (samePath || worktreeOwner(ctx.wtRoot, ctx.root, existing.path) === 'omp') {
    return { branch: target.branch, path: samePath ? target.path : existing.path, status: 'reused' };
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
  return { branch: target.branch, path: target.path, status: 'relocated' };
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
 * creates or reuses the tern-managed worktree of a branch or pull request, and opens or focuses its Tern tab.
 * An omp-owned worktree of the branch opens where it is, and so does the omp checkout of a same-repository pull request, on branch `pr-<n>`.
 * omp clone mode, the omp setting `worktree.clone` in the repository, makes new worktrees through omp.
 */
export const run = async (args: string[]): Promise<CreateResult> => {
  const options = parse(args);
  const { repo, source } = checkOptions(options);
  const root = await requireRepoRoot(repo);
  const [wtRoot, probe, withOrigin] = await Promise.all([worktreeRoot(), ompSettings(root), hasOrigin(root)]);
  const warnings = probe.warning === null ? [] : [probe.warning];
  const clone = probe.settings?.clone === true ? probe.omp : null;
  const ctx: Context = { carry: null, clone, repoName: path.basename(root), root, warnings, withOrigin, wtRoot };
  if (ctx.withOrigin) {
    const fetchWarning = await fetchOrigin(root, true);
    if (fetchWarning !== null) {
      ctx.warnings.push(fetchWarning);
    }
  }
  const { isNew, target } = await sourceTarget(ctx, source);
  let placed: Placed;
  let carried: string[] = [];
  try {
    placed = await placeWorktree(ctx, target, { isNew, relocate: options.relocate });
    if (placed.status !== 'reused') {
      await updateSubmodules(ctx, placed.path);
    }
    if (ctx.carry !== null) {
      carried = unstage(ctx, ctx.carry, placed.path);
    }
  } catch (error) {
    if (ctx.carry === null) {
      throw error;
    }
    // SAFETY: the steps after staging throw a CliError, or an Error from node:fs.
    throw withStaging(error as Error, ctx.carry.staging);
  }
  const tab = options['no-tab'] ? null : await tryOpenTab(ctx, { ...target, branch: placed.branch, path: placed.path });
  return { branch: placed.branch, carried, path: placed.path, repo: root, status: placed.status, tab, warnings: ctx.warnings };
};
