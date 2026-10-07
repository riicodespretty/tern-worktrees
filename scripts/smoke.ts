import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { must, run } from '../src/proc.ts';
import { blocksUnder, ls, ternBin } from '../src/tern.ts';

interface Tab {
  opened: boolean;
}

interface Created {
  path: string;
  status: string;
  tab: Tab | null;
}

interface Listed {
  worktrees: unknown[];
}

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt');
const name = `twt-smoke-${Math.floor(Date.now() / 1000)}`;
const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'twt-smoke-'));
const env = {
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  TERN_PLUGIN_DATA: path.join(base, 'plugin-data'),
  TERN_WT_HOME: path.join(base, 'home'),
};

const check = (ok: boolean, message: string): void => {
  if (!ok) {
    throw new Error(message);
  }
};

const git = async (cwd: string, ...args: string[]): Promise<string> => await must(['git', '-C', cwd, ...args], 'git_failed', { env });

const cli = async <T>(...args: string[]): Promise<T> => {
  const result = await run([CLI, ...args], { env });
  check(result.status === 0, `tern-wt ${args.join(' ')} exited ${result.status}: ${result.stdout.trim()}`);
  // SAFETY: the CLI prints one JSON object for each command.
  return JSON.parse(result.stdout) as T;
};

const makeClone = async (): Promise<string> => {
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, name);
  await git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  await git(base, 'clone', '--quiet', origin, clone);
  await git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(clone, 'README.md'), 'smoke\n');
  await git(clone, 'add', 'README.md');
  await git(clone, 'commit', '--quiet', '-m', 'initial');
  await git(clone, 'push', '--quiet', '-u', 'origin', 'main', 'main:refs/heads/feature/x');
  await git(clone, 'remote', 'set-head', 'origin', 'main');
  return clone;
};

const waitForBlock = async (dir: string, attempts = 50): Promise<void> => {
  const blocks = await blocksUnder(dir);
  if (blocks.length > 0) {
    return;
  }
  check(attempts > 1, `no block under ${dir} after 5s`);
  await sleep(100);
  await waitForBlock(dir, attempts - 1);
};

const smoke = async (): Promise<void> => {
  const clone = await makeClone();
  const created = await cli<Created>('create', '--repo', clone, '--branch', 'feature/x');
  check(created.status === 'created', `create: status ${created.status}, not created`);
  check(created.tab?.opened === true, 'create: the tab did not open');
  await waitForBlock(created.path);
  const reused = await cli<Created>('create', '--repo', clone, '--branch', 'feature/x');
  check(reused.status === 'reused', `create again: status ${reused.status}, not reused`);
  check(reused.tab?.opened === false, 'create again: a new tab opened');
  const listed = await cli<Listed>('list');
  check(listed.worktrees.length === 1, `list: ${listed.worktrees.length} worktrees, not 1`);
  await cli('remove', created.path);
  check(!existsSync(created.path), `remove: ${created.path} still exists`);
  const left = await blocksUnder(created.path);
  check(left.length === 0, `remove: ${left.length} blocks left under ${created.path}`);
};

const cleanUp = async (): Promise<void> => {
  const listing = await ls();
  if (listing.sessions.some(session => session.name === name)) {
    await must([ternBin(), 'kill', 'session', name, '--json'], 'tern_failed');
  }
  rmSync(base, { force: true, recursive: true });
};

mkdirSync(env.TERN_PLUGIN_DATA, { recursive: true });
try {
  await smoke();
  await cleanUp();
  process.stdout.write('smoke ok\n');
} catch (error) {
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await cleanUp();
  process.exitCode = 1;
}
