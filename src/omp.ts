import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, isString } from './json.ts';
import { CliError, run } from './proc.ts';

/** The omp settings that `tern-wt` reads: `base`, the setting `worktree.base` when it is a string, and `clone`, true when `worktree.clone` is true. */
export interface OmpSettings {
  base: string | null;
  clone: boolean;
}

/**
 * What {@link ompSettings} found. `omp` is the omp binary, null when omp is not installed. `settings` is null when omp is not installed
 * or when it is on disk but failed, and `warning` then tells why.
 */
export type OmpProbe = { omp: null; settings: null; warning: null } | { omp: string; settings: null; warning: string } | { omp: string; settings: OmpSettings; warning: null };

/** The part of `omp config list --json` that `tern-wt` reads: the entry of each setting, with `value` when the setting has one. */
interface OmpListing {
  'worktree.base'?: { value?: unknown } | null;
  'worktree.clone'?: { value?: unknown } | null;
}

const isExecutableFile = (file: string): boolean => {
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return false;
  }
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The omp binary: `$TERN_WT_OMP` when it is set, else `omp` from `PATH`. Null when that file is not an executable file. */
export const findOmp = (): string | null => {
  const configured = process.env.TERN_WT_OMP;
  const candidates =
    configured !== undefined && configured !== ''
      ? [configured]
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .filter(dir => dir !== '')
          .map(dir => path.join(dir, 'omp'));
  return candidates.find(isExecutableFile) ?? null;
};

const parseSettings = (stdout: string): OmpSettings | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) {
    return null;
  }
  // SAFETY: each entry of a JSON object is a JSON value, and `?.value` reads a JSON value of each type without a throw.
  const listing = parsed as OmpListing;
  const base = listing['worktree.base']?.value;
  return { base: isString(base) ? base : null, clone: listing['worktree.clone']?.value === true };
};

/**
 * The omp settings that apply in `cwd`, from `omp config list --json` run in `cwd`, so the config of the project at `cwd` applies.
 * A failed run or output that is not a JSON object gives null settings and a warning.
 */
export const ompSettings = async (cwd: string): Promise<OmpProbe> => {
  const omp = findOmp();
  if (omp === null) {
    return { omp: null, settings: null, warning: null };
  }
  const result = await run([omp, 'config', 'list', '--json'], { cwd });
  if (result.status !== 0) {
    const reason = result.stderr.trim() || `exit ${result.status}`;
    return { omp, settings: null, warning: `omp config list failed: ${reason}` };
  }
  const settings = parseSettings(result.stdout);
  if (settings === null) {
    return { omp, settings: null, warning: 'omp config list printed no JSON object' };
  }
  return { omp, settings, warning: null };
};

/**
 * Runs `omp worktree add -q -C <repo> <args>`, which fills the new worktree with a copy-on-write clone of the checkout at `repo`.
 * Returns each line that omp printed to standard error as a warning, for example that the clone fell back to a checkout.
 * Throws `git_failed` when omp fails.
 */
export const ompWorktreeAdd = async (omp: string, repo: string, args: string[]): Promise<string[]> => {
  const result = await run([omp, 'worktree', 'add', '-q', '-C', repo, ...args]);
  if (result.status !== 0) {
    throw new CliError('git_failed', result.stderr.trim() || `omp worktree add exited ${result.status}`);
  }
  return result.stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => `omp: ${line}`);
};
