import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import type { Teardown } from '../config.ts';
import { currentBranch, fetchOrigin, gitMust, gitRun, hardToRebuild, isAncestor, linkedWorktreeRoot, requireRepoRoot, worktreeLosses } from '../git.ts';
import { defaultBranch, listPullRequests, originRepo } from '../github.ts';
import { isUnder, worktreeRoot } from '../paths.ts';
import { CliError } from '../proc.ts';
import { blocksUnder, close } from '../tern.ts';

/** The output of `remove`. */
export interface RemoveResult {
  removed: string;
  branch: string | null;
  branchDeleted: boolean;
  closedBlocks: number[];
  warnings: string[];
}

interface Options {
  'force': boolean;
  'keep-tab': boolean;
  'target': string;
}

interface Context {
  root: string;
  target: string;
  warnings: string[];
}

const parse = (args: string[]): Options => {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: { 'force': { default: false, type: 'boolean' }, 'keep-tab': { default: false, type: 'boolean' } },
  });
  const [target, ...rest] = parsed.positionals;
  if (target === undefined || rest.length > 0) {
    throw new CliError('bad_args', 'remove needs one <path>');
  }
  const resolved = path.resolve(target);
  return { ...parsed.values, target: existsSync(resolved) ? realpathSync(resolved) : resolved };
};

const warnOnCliError = async <T>(ctx: Context, label: string, fallback: T, action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    ctx.warnings.push(`${label}: ${error.message}`);
    return fallback;
  }
};

const removeWorktree = async (ctx: Context, force: boolean): Promise<void> => {
  if (force) {
    const forcedRemoval = await gitRun(ctx.root, 'worktree', 'remove', '--force', '--force', ctx.target);
    if (forcedRemoval.status !== 0 || existsSync(ctx.target)) {
      rmSync(ctx.target, { force: true, recursive: true });
      await gitRun(ctx.root, 'worktree', 'prune');
    }
    return;
  }
  const ignored = await hardToRebuild(ctx.target);
  if (ignored.length === 0) {
    const removal = await gitRun(ctx.root, '-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', ctx.target);
    if (removal.status === 0) {
      return;
    }
    if (!removal.stderr.includes('working trees containing submodules cannot be moved or removed')) {
      throw new CliError('git_failed', removal.stderr.trim());
    }
  }
  const files = [...(await worktreeLosses(ctx.target)), ...ignored.map(file => `!! ${file}`)];
  if (files.length > 0) {
    throw new CliError('dirty_worktree', `${ctx.target} has work that removing it would lose`, { existing: ctx.target, files });
  }
  await gitMust(ctx.root, 'worktree', 'remove', '--force', ctx.target);
};

const closeBlocks = async (ctx: Context, blocks: number[]): Promise<number[]> => {
  const closed = await Promise.all(
    blocks.map(
      async block =>
        await warnOnCliError(ctx, `block ${block} not closed`, null, async () => {
          await close(block);
          return block;
        }),
    ),
  );
  return closed.filter(block => block !== null);
};

const hasMergedPullRequest = async (ctx: Context, branch: string): Promise<boolean> => {
  const repoRef = await originRepo(ctx.root);
  if (repoRef === null) {
    return false;
  }
  const { error, prs } = await listPullRequests(repoRef, [`--head=${branch}`, '--state', 'merged'], ['headRefOid']);
  if (error !== null) {
    ctx.warnings.push(`merged PR check failed: ${error}`);
    return false;
  }
  const held = await Promise.all(prs.map(async pr => await isAncestor(ctx.root, `refs/heads/${branch}`, pr.headRefOid)));
  return held.includes(true);
};

const isMerged = async (ctx: Context, branch: string): Promise<boolean> => {
  const fetchWarning = await fetchOrigin(ctx.root, false);
  if (fetchWarning !== null) {
    ctx.warnings.push(fetchWarning);
  }
  const base = await defaultBranch(ctx.root);
  return (await isAncestor(ctx.root, `refs/heads/${branch}`, `origin/${base}`)) || (await hasMergedPullRequest(ctx, branch));
};

const applyPolicy = async (ctx: Context, teardown: Teardown, branch: string): Promise<boolean> => {
  if (teardown === 'worktree') {
    return false;
  }
  if (teardown === 'worktree+merged-branch' && !(await warnOnCliError(ctx, 'merge check failed', false, async () => await isMerged(ctx, branch)))) {
    ctx.warnings.push(`kept branch ${branch}: not merged`);
    return false;
  }
  const deletion = await gitRun(ctx.root, 'branch', '-D', '--', branch);
  if (deletion.status !== 0) {
    ctx.warnings.push(`branch ${branch} not deleted: ${deletion.stderr.trim()}`);
    return false;
  }
  return true;
};

/**
 * `remove <path> [--force] [--keep-tab]`: removes a managed worktree, closes the Tern blocks in the worktree,
 * then deletes its branch if the teardown policy tells it to. Ignored files that are hard to rebuild stop it like uncommitted changes do.
 * `--force` discards the two.
 */
export const run = async (args: string[]): Promise<RemoveResult> => {
  const options = parse(args);
  const { target } = options;
  const { teardown } = loadConfig();
  if (!isUnder(target, worktreeRoot())) {
    throw new CliError('not_managed', `${target} is not under ${worktreeRoot()}`);
  }
  const root = await linkedWorktreeRoot(target);
  if (root === null) {
    const mainCheckout = await requireRepoRoot(target);
    throw new CliError('not_managed', `${target} is not the top directory of a linked worktree of ${mainCheckout}`);
  }
  const branch = await currentBranch(target);
  const ctx: Context = { root, target, warnings: [] };
  const blocks = options['keep-tab']
    ? []
    : await warnOnCliError(ctx, 'tabs not closed', [], async () => {
        const placed = await blocksUnder(target);
        return placed.map(entry => entry.block.id);
      });
  await removeWorktree(ctx, options.force);
  const closedBlocks = await closeBlocks(ctx, blocks);
  const branchDeleted = branch !== null && (await applyPolicy(ctx, teardown, branch));
  return { branch, branchDeleted, closedBlocks, removed: target, warnings: ctx.warnings };
};
