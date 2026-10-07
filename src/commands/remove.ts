import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import type { Teardown } from '../config.ts';
import { defaultBranch, dirtyFiles, originSlug, repoRoot } from '../git.ts';
import { isUnder, worktreeRoot } from '../paths.ts';
import { CliError, must, run as runProcess } from '../proc.ts';
import { blocksUnder, close } from '../tern.ts';
import { currentBranch, linkedWorktreeRoot } from './list.ts';

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
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args,
      options: { 'force': { default: false, type: 'boolean' }, 'keep-tab': { default: false, type: 'boolean' } },
    });
  } catch (error) {
    // SAFETY: `parseArgs` throws a TypeError for each bad argument.
    throw new CliError('bad_args', (error as TypeError).message);
  }
  const [target, ...rest] = parsed.positionals;
  if (target === undefined || rest.length > 0) {
    throw new CliError('bad_args', 'remove needs one <path>');
  }
  return { ...parsed.values, target: path.resolve(target) };
};

const warnOn = async <T>(ctx: Context, label: string, fallback: T, action: () => Promise<T>): Promise<T> => {
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
    const forced = await runProcess(['git', '-C', ctx.root, 'worktree', 'remove', '--force', '--force', ctx.target]);
    if (forced.status !== 0 || existsSync(ctx.target)) {
      rmSync(ctx.target, { force: true, recursive: true });
      await runProcess(['git', '-C', ctx.root, 'worktree', 'prune']);
    }
    return;
  }
  const result = await runProcess(['git', '-C', ctx.root, 'worktree', 'remove', ctx.target]);
  if (result.status === 0) {
    return;
  }
  if (result.stderr.includes('working trees containing submodules cannot be moved or removed')) {
    const files = await dirtyFiles(ctx.target);
    if (files.length === 0) {
      await must(['git', '-C', ctx.root, 'worktree', 'remove', '--force', ctx.target], 'git_failed');
      return;
    }
  }
  throw new CliError('git_failed', result.stderr.trim());
};

const closeBlocks = async (ctx: Context, blocks: number[]): Promise<number[]> => {
  const closed = await Promise.all(
    blocks.map(
      async block =>
        await warnOn(ctx, `block ${block} not closed`, null, async () => {
          await close(block);
          return block;
        }),
    ),
  );
  return closed.filter(block => block !== null);
};

const hasMergedPullRequest = async (ctx: Context, branch: string): Promise<boolean> => {
  const slug = await originSlug(ctx.root);
  if (slug === null) {
    return false;
  }
  const result = await runProcess(['gh', 'pr', 'list', '--repo', `${slug.owner}/${slug.name}`, '--head', branch, '--state', 'merged', '--json', 'number', '--jq', 'length']);
  if (result.status !== 0) {
    ctx.warnings.push(`merged PR check failed: ${result.stderr.trim()}`);
    return false;
  }
  return Number(result.stdout) > 0;
};

const isMerged = async (ctx: Context, branch: string): Promise<boolean> => {
  const fetch = await runProcess(['git', '-C', ctx.root, 'fetch', 'origin']);
  if (fetch.status !== 0) {
    ctx.warnings.push(`fetch failed: ${fetch.stderr.trim()}`);
  }
  const base = await defaultBranch(ctx.root);
  const ancestor = await runProcess(['git', '-C', ctx.root, 'merge-base', '--is-ancestor', branch, `origin/${base}`]);
  return ancestor.status === 0 || (await hasMergedPullRequest(ctx, branch));
};

const applyPolicy = async (ctx: Context, teardown: Teardown, branch: string): Promise<boolean> => {
  if (teardown === 'worktree') {
    return false;
  }
  if (teardown === 'worktree+merged-branch' && !(await warnOn(ctx, 'merge check failed', false, async () => await isMerged(ctx, branch)))) {
    ctx.warnings.push(`kept branch ${branch}: not merged`);
    return false;
  }
  const deleted = await runProcess(['git', '-C', ctx.root, 'branch', '-D', branch]);
  if (deleted.status !== 0) {
    ctx.warnings.push(`branch ${branch} not deleted: ${deleted.stderr.trim()}`);
    return false;
  }
  return true;
};

/**
 * `remove <path> [--force] [--keep-tab]`: removes a managed worktree, then its branch as the teardown policy says,
 * then closes the Tern blocks in it. `--force` discards uncommitted changes.
 */
export const run = async (args: string[]): Promise<RemoveResult> => {
  const options = parse(args);
  const { target } = options;
  const { teardown } = loadConfig();
  if (!isUnder(target, worktreeRoot())) {
    throw new CliError('not_managed', `${target} is not under ${worktreeRoot()}`);
  }
  const repo = await repoRoot(target);
  if (repo === null) {
    throw new CliError('not_a_repo', `${target} is not in a git repository`);
  }
  const root = await linkedWorktreeRoot(target);
  if (root === null) {
    throw new CliError('not_managed', `${target} is not the top directory of a linked worktree of ${repo}`);
  }
  const branch = await currentBranch(target);
  const ctx: Context = { root, target, warnings: [] };
  const blocks = options['keep-tab']
    ? []
    : await warnOn(ctx, 'tabs not closed', [], async () => {
        const placed = await blocksUnder(target);
        return placed.map(entry => entry.block.id);
      });
  await removeWorktree(ctx, options.force);
  const closedBlocks = await closeBlocks(ctx, blocks);
  const branchDeleted = branch !== null && (await applyPolicy(ctx, teardown, branch));
  return { branch, branchDeleted, closedBlocks, removed: target, warnings: ctx.warnings };
};
