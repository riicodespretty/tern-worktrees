import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, setupCommands } from '../config.ts';
import { fetchOrigin, gitMust, gitRun, gitSucceeds, requireRepoRoot, updateSubmodules, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { defaultBranch, ghMust, ghMustWith, readOrigin } from '../github.ts';
import type { GhPullRequest, Origin } from '../github.ts';
import { ompSettings, ompWorktreeAdd } from '../omp.ts';
import { isUnder, worktreeOwner, worktreePath, worktreeRoot } from '../paths.ts';
import type { WorktreeOwner, WorktreeRoot } from '../paths.ts';
import { CliError } from '../proc.ts';
import { nameWithOwner } from '../repo-ref.ts';
import { blocksUnder, focus, ls, newSession, newTab, rename, sessionForRepo, typeInto, waitForPrompt } from '../tern.ts';
import { guardWorkToLose } from '../work-to-lose.ts';

/** How `create` got the worktree. */
export type CreateStatus = 'created' | 'relocated' | 'reused';

/** How long `create` waits for the shell prompt of the tab it opened before it types the setup commands. */
const SETUP_PROMPT_SECONDS = 30;

/** Who owns the worktree that `create` gives: `tern` or `omp` as {@link worktreeOwner} says, or `main` for the main checkout. */
type Owner = Exclude<WorktreeOwner, null> | 'main';

/** The Tern tab that shows the worktree. */
export interface CreatedTab {
  block: number;
  opened: boolean;
  session: string;
}

/**
 * The output of `create`. `carried` lists the ignored files that a relocation copied into the rebuilt worktree, and is empty otherwise.
 * `owner` is `tern` for a tern-managed worktree, `omp` for an omp-owned one and `main` for the main checkout.
 * `setup` holds the setup commands of a new worktree as one `line`. `typed` is true when `create` typed the line into the tab that it opened. `setup` is null for a reused or relocated worktree, and for a repository without setup commands.
 */
export interface CreateResult {
  branch: string;
  carried: string[];
  owner: Owner;
  path: string;
  repo: string;
  setup: { line: string; typed: boolean } | null;
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

/** The hard-to-rebuild files of the first worktree, and the temporary folder that keeps their copies. */
interface Carry {
  files: string[];
  staging: string;
}

/** What `moveOrClear` gives when git refused the move and the first worktree is gone: the carried files and the first line of the refusal. */
interface Cleared {
  carry: Carry;
  refusal: string;
}

/** `clone` is the omp binary when omp clone mode makes the worktrees, else null. */
interface Context {
  clone: string | null;
  fetchWarning: string | null;
  origin: Origin;
  repoName: string;
  root: string;
  warnings: string[];
  wtRoot: WorktreeRoot;
}

/** `ompPrBranch` is `pr-<n>`, the branch of the omp checkout of a same-repository pull request, else null. `isNew` is true for `--new`. */
interface Target {
  branch: string;
  forkPr: string | null;
  isNew: boolean;
  ompPrBranch: string | null;
  path: string;
  pr: string | null;
}

/** `owner` is the {@link worktreeOwner} of `path`, or `main` for the main checkout. `carried` lists the hard-to-rebuild files that a rebuilt relocation copied into the worktree, and is empty otherwise. */
interface Placed {
  branch: string;
  carried: string[];
  owner: Owner;
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
  const repoRef = ctx.origin.github;
  if (repoRef === null) {
    throw badArgs('--pr needs a GitHub origin');
  }
  const view = await ghMust('pr', 'view', pr, '--repo', nameWithOwner(repoRef), '--json', 'number,headRefName,isCrossRepository');
  // SAFETY: `gh pr view --json` prints the fields that its `--json` flag names.
  const { headRefName, isCrossRepository } = JSON.parse(view) as Pick<GhPullRequest, 'headRefName' | 'isCrossRepository'>;
  if (isCrossRepository) {
    const branch = `pr-${pr}`;
    return { branch, forkPr: pr, isNew: false, ompPrBranch: null, path: worktreePath(ctx.wtRoot, ctx.repoName, branch), pr };
  }
  return { branch: headRefName, forkPr: null, isNew: false, ompPrBranch: `pr-${pr}`, path: worktreePath(ctx.wtRoot, ctx.repoName, headRefName), pr };
};

const sourceTarget = async (ctx: Context, source: Source): Promise<Target> => {
  if ('branch' in source) {
    return { branch: source.branch, forkPr: null, isNew: source.isNew, ompPrBranch: null, path: worktreePath(ctx.wtRoot, ctx.repoName, source.branch), pr: null };
  }
  return await pullRequestTarget(ctx, source.pr);
};

const startPoint = async (ctx: Context): Promise<string> => {
  const name = await defaultBranch(ctx.root, ctx.origin.github);
  return ctx.origin.present ? `origin/${name}` : name;
};

const hasRef = async (ctx: Context, ref: string): Promise<boolean> => await gitSucceeds(ctx.root, 'rev-parse', '--verify', '--quiet', ref);

const checkBranch = async (ctx: Context, target: Target): Promise<void> => {
  if (!(await gitSucceeds(ctx.root, 'check-ref-format', '--branch', target.branch))) {
    throw badArgs(`bad branch name ${target.branch}`);
  }
  if (target.isNew && ((await hasRef(ctx, `refs/heads/${target.branch}`)) || (await hasRef(ctx, `refs/remotes/origin/${target.branch}`)))) {
    throw badArgs(`branch ${target.branch} already exists`);
  }
};

const addSpec = async (ctx: Context, target: Target): Promise<AddSpec> => {
  if (target.forkPr !== null) {
    return { detach: true, newBranch: null, start: await startPoint(ctx), track: false };
  }
  if (target.isNew) {
    return { detach: false, newBranch: target.branch, start: await startPoint(ctx), track: false };
  }
  if (await hasRef(ctx, `refs/heads/${target.branch}`)) {
    return { detach: false, newBranch: null, start: target.branch, track: false };
  }
  if (await hasRef(ctx, `refs/remotes/origin/${target.branch}`)) {
    return { detach: false, newBranch: target.branch, start: `origin/${target.branch}`, track: true };
  }
  if (target.pr === null) {
    throw badArgs(`no branch ${target.branch}; pass --new to create it`);
  }
  if (ctx.fetchWarning === null) {
    throw badArgs(`branch ${target.branch} of pull request ${target.pr} is not on origin; it may have been deleted`);
  }
  throw new CliError('git_failed', `no branch ${target.branch} of pull request ${target.pr} locally or on origin; ${ctx.fetchWarning}`);
};

const addArgs = (spec: AddSpec): string[] => [...(spec.detach ? ['--detach'] : []), ...(spec.newBranch === null ? [] : ['-b', spec.newBranch])];

/**
 * Adds the worktree with `omp worktree add` when `ctx.clone` is the omp binary, else with `git worktree add`. omp sets no upstream, so in clone mode
 * `git branch` makes a new branch first: it sets the same upstream as `git worktree add -b`, and omp then checks out that branch.
 */
const addWith = async (ctx: Context, target: Target, spec: AddSpec): Promise<void> => {
  if (ctx.clone === null) {
    await gitMust(ctx.root, 'worktree', 'add', ...(spec.track ? ['--track'] : []), ...addArgs(spec), '--', target.path, spec.start);
    return;
  }
  if (spec.newBranch === null) {
    ctx.warnings.push(...(await ompWorktreeAdd(ctx.clone, ctx.root, [...addArgs(spec), target.path, spec.start])));
    return;
  }
  await gitMust(ctx.root, 'branch', ...(spec.track ? ['--track'] : []), spec.newBranch, spec.start);
  try {
    ctx.warnings.push(...(await ompWorktreeAdd(ctx.clone, ctx.root, [target.path, spec.newBranch])));
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

/** Adds the worktree of `target`, through omp when `ctx.clone` is the omp binary. A fork pull request gets a detached worktree, then `gh pr checkout`. */
const addWorktree = async (ctx: Context, target: Target): Promise<void> => {
  assertPathFree(target);
  await addWith(ctx, target, await addSpec(ctx, target));
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

const copyAll = (from: string, to: string, files: string[]): void => {
  for (const file of files) {
    copyEntry(path.join(from, file), path.join(to, file));
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

/** Runs `step`, and adds the staging folder of `carry` to each error that it throws. */
const afterStaging = async <T>(carry: Carry, step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    // SAFETY: the steps after staging throw a CliError, or an Error from node:fs.
    throw withStaging(error as Error, carry.staging);
  }
};

const moveOrClear = async (ctx: Context, target: Target, existing: Worktree): Promise<Cleared | null> => {
  const moved = await gitRun(ctx.root, 'worktree', 'move', existing.path, target.path);
  if (moved.status === 0) {
    return null;
  }
  const files = await guardWorkToLose(existing.path, 'recreating');
  const carry: Carry = { files, staging: mkdtempSync(path.join(tmpdir(), 'tern-wt-carry-')) };
  await afterStaging(carry, async () => {
    copyAll(existing.path, carry.staging, carry.files);
    await gitMust(ctx.root, 'worktree', 'remove', '--force', '--force', existing.path);
  });
  const [refusal] = moved.stderr.split('\n');
  return { carry, refusal };
};

/** Updates the submodules of the worktree at `dir`, and adds their warnings to `ctx.warnings`. */
const updateWorktreeSubmodules = async (ctx: Context, dir: string): Promise<void> => {
  ctx.warnings.push(...(await updateSubmodules(ctx.root, dir)));
};

/**
 * Adds the worktree of `target` again after `moveOrClear` removed it, updates its submodules, then copies the carried files into it. Gives the carried files.
 * It adds the worktree again with plain git, because clone mode does not apply to a rebuild. The branch of `target` is not new, so it passes
 * `isNew: false`.
 */
const rebuild = async (ctx: Context, target: Target, cleared: Cleared): Promise<string[]> =>
  await afterStaging(cleared.carry, async () => {
    await addWorktree({ ...ctx, clone: null }, { ...target, isNew: false });
    ctx.warnings.push(`recreated: git worktree move refused (${cleared.refusal})`);
    await updateWorktreeSubmodules(ctx, target.path);
    return unstage(ctx, cleared.carry, target.path);
  });

/** Moves the worktree `existing` to the path of `target`, or rebuilds it there when git refuses the move. Gives the carried files. */
const relocate = async (ctx: Context, target: Target, existing: Worktree): Promise<string[]> => {
  assertPathFree(target);
  mkdirSync(path.dirname(target.path), { recursive: true });
  const lockReason = existing.locked;
  if (lockReason !== null) {
    await gitMust(ctx.root, 'worktree', 'unlock', existing.path);
  }
  let cleared: Cleared | null;
  try {
    cleared = await moveOrClear(ctx, target, existing);
  } catch (error) {
    if (lockReason !== null) {
      await gitMust(ctx.root, 'worktree', 'lock', '--reason', lockReason, existing.path);
    }
    throw error;
  }
  if (cleared === null) {
    await updateWorktreeSubmodules(ctx, target.path);
    return [];
  }
  return await rebuild(ctx, target, cleared);
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
  return headRef.status !== 0 || headRef.stdout.trim() === target.branch ? { branch, carried: [], owner: 'omp', path: found.path, status: 'reused' } : null;
};

const placeWorktree = async (ctx: Context, target: Target, mayRelocate: boolean): Promise<Placed> => {
  await checkBranch(ctx, target);
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
    await addWorktree(ctx, target);
    await updateWorktreeSubmodules(ctx, target.path);
    return { branch: target.branch, carried: [], owner: 'tern', path: target.path, status: 'created' };
  }
  const samePath = isUnder(existing.path, target.path) && isUnder(target.path, existing.path);
  if (samePath || worktreeOwner(ctx.wtRoot, ctx.root, existing.path) === 'omp') {
    return { branch: target.branch, carried: [], owner: samePath ? 'tern' : 'omp', path: samePath ? target.path : existing.path, status: 'reused' };
  }
  if (existing.main) {
    return { branch: target.branch, carried: [], owner: 'main', path: existing.path, status: 'reused' };
  }
  if (!mayRelocate) {
    throw new CliError('worktree_exists_elsewhere', `${target.branch} has a worktree at ${existing.path}; pass --relocate to move it to ${target.path}`, {
      existing: existing.path,
      target: target.path,
    });
  }
  const carried = await relocate(ctx, target, existing);
  return { branch: target.branch, carried, owner: 'tern', path: target.path, status: 'relocated' };
};

const openTab = async (ctx: Context, placed: Placed): Promise<CreatedTab> => {
  const listing = await ls();
  const existingBlock = blocksUnder(listing, placed.path).at(0);
  if (existingBlock) {
    await focus(existingBlock.block.id);
    return { block: existingBlock.block.id, opened: false, session: existingBlock.session.name };
  }
  const session = await sessionForRepo(listing, ctx.root);
  const block = session === null ? await newSession(ctx.repoName, placed.path) : await newTab(session.name, placed.path);
  await rename(block, placed.branch);
  return { block, opened: true, session: session?.name ?? ctx.repoName };
};

const tryOpenTab = async (ctx: Context, placed: Placed): Promise<CreatedTab | null> => {
  try {
    return await openTab(ctx, placed);
  } catch (error) {
    if (error instanceof CliError) {
      ctx.warnings.push(`tab not opened: ${error.message}`);
      return null;
    }
    throw error;
  }
};

/** The setup commands of the repository as one line, with ` && ` between them. Null unless the worktree is new and the options file lists commands for the name with owner of its GitHub origin. */
const setupLine = (ctx: Context, status: CreateStatus): string | null => {
  const repoRef = status === 'created' ? ctx.origin.github : null;
  const commands = repoRef === null ? [] : setupCommands(loadConfig(), repoRef);
  return commands.length === 0 ? null : commands.join(' && ');
};

/**
 * Types `line` into the tab that `create` opened when its shell shows the prompt. Gives true when it typed the line. Without a tab it adds no warning: the caller types the line.
 * A tab that was open before, no prompt in {@link SETUP_PROMPT_SECONDS} and a Tern failure each add a warning and keep the worktree.
 */
const typeSetup = async (ctx: Context, line: string, tab: CreatedTab | null): Promise<boolean> => {
  if (tab === null) {
    return false;
  }
  if (!tab.opened) {
    ctx.warnings.push('setup not run: the tab was open before');
    return false;
  }
  try {
    if (!(await waitForPrompt(tab.block, SETUP_PROMPT_SECONDS))) {
      ctx.warnings.push(`setup not run: no shell prompt in ${SETUP_PROMPT_SECONDS} s`);
      return false;
    }
    await typeInto(tab.block, line);
    return true;
  } catch (error) {
    // SAFETY: `waitForPrompt` and `typeInto` throw a CliError only.
    ctx.warnings.push(`setup not run: ${(error as CliError).message}`);
    return false;
  }
};

/**
 * `create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`:
 * creates or reuses the tern-managed worktree of a branch or pull request, and opens or focuses its Tern tab.
 * An omp-owned worktree of the branch opens where it is, and so do the omp checkout of a same-repository pull request, on branch `pr-<n>`, and the main checkout.
 * omp clone mode, the omp setting `worktree.clone` in the repository, makes new worktrees through omp.
 */
export const run = async (args: string[]): Promise<CreateResult> => {
  const options = parse(args);
  const { repo, source } = checkOptions(options);
  const root = await requireRepoRoot(repo);
  const [wtRoot, probe, origin] = await Promise.all([worktreeRoot(), ompSettings(root), readOrigin(root)]);
  const fetchWarning = origin.present ? await fetchOrigin(root, true) : null;
  const warnings = [probe.warning, fetchWarning].filter(warning => warning !== null);
  const clone = probe.settings?.clone === true ? probe.omp : null;
  const ctx: Context = { clone, fetchWarning, origin, repoName: path.basename(root), root, warnings, wtRoot };
  const target = await sourceTarget(ctx, source);
  const placed = await placeWorktree(ctx, target, options.relocate);
  const tab = options['no-tab'] ? null : await tryOpenTab(ctx, placed);
  const line = setupLine(ctx, placed.status);
  const setup = line === null ? null : { line, typed: await typeSetup(ctx, line, tab) };
  return { branch: placed.branch, carried: placed.carried, owner: placed.owner, path: placed.path, repo: root, setup, status: placed.status, tab, warnings: ctx.warnings };
};
