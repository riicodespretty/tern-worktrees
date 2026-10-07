import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** The error codes the CLI reports in its error envelope. */
export type ErrorCode =
  | 'bad_args'
  | 'config_invalid'
  | 'not_a_repo'
  | 'not_managed'
  | 'path_conflict'
  | 'branch_in_main_checkout'
  | 'worktree_exists_elsewhere'
  | 'dirty_worktree'
  | 'git_failed'
  | 'gh_failed'
  | 'tern_failed';

/** The added fields of the error envelope, for example the conflicting path or the changed files. */
export type ErrorExtra = Record<string, string | string[]>;

/** A failure that the CLI reports with a code, a message and added fields. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly extra: ErrorExtra;

  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.extra = extra;
  }
}

/** The exit status and output of a completed process. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Where a process runs and the env vars it gets on top of `process.env`. */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Runs `argv` until it stops and collects its output.
 * A program that fails to start gives status 127 with the spawn error in `stderr`. A signal gives status 1.
 */
export const run = async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
  const [command, ...args] = argv;
  const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  try {
    await once(child, 'close');
  } catch (error) {
    return { status: 127, stderr: String(error), stdout: '' };
  }
  return { status: child.exitCode ?? 1, stderr: Buffer.concat(stderr).toString(), stdout: Buffer.concat(stdout).toString() };
};

/** Runs `argv` and returns its `stdout`, or throws a `CliError` with `code` when it exits with a status other than 0. */
export const must = async (argv: string[], code: ErrorCode, opts: RunOptions = {}): Promise<string> => {
  const result = await run(argv, opts);
  if (result.status !== 0) {
    throw new CliError(code, result.stderr.trim() || `${argv[0]} exited ${result.status}`);
  }
  return result.stdout;
};
