import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CreateResult } from '../src/commands/create.ts';
import type { ListResult } from '../src/commands/list.ts';
import { run } from '../src/proc.ts';
import { blocksUnder, ternBin } from '../src/tern.ts';
import { buildRepo, gitWith } from './repo-fixture.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt');
const smokeName = `twt-smoke-${Math.floor(Date.now() / 1000)}`;
const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'twt-smoke-'));
const env = {
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  TERN_CONFIG_DIR: path.join(tempRoot, 'tern-config'),
  TERN_DAEMON_SOCKET: path.join(tempRoot, 'tern.sock'),
  TERN_PLUGIN_DATA: path.join(tempRoot, 'plugin-data'),
  TERN_WT_HOME: path.join(tempRoot, 'home'),
};
Object.assign(process.env, env);

const check = (ok: boolean, message: string): void => {
  if (!ok) {
    throw new Error(message);
  }
};

const git = gitWith({ env });

const cli = async <T>(...args: string[]): Promise<T> => {
  const result = await run([CLI, ...args], { env });
  check(result.status === 0, `tern-wt ${args.join(' ')} exited ${result.status}: ${result.stdout.trim()}`);
  // SAFETY: the CLI prints one JSON object for each command.
  return JSON.parse(result.stdout) as T;
};

const makeClone = async (): Promise<string> => {
  const repo = await buildRepo(git, tempRoot, smokeName, 'smoke\n');
  await repo.pushBranch('feature/x');
  return repo.dir;
};

const waitFor = async (ready: () => boolean | Promise<boolean>, what: string, attempts = 50): Promise<void> => {
  if (await ready()) {
    return;
  }
  check(attempts > 1, `${what} after 5s`);
  await sleep(100);
  await waitFor(ready, what, attempts - 1);
};

const waitForBlock = async (dir: string): Promise<void> => {
  await waitFor(async () => {
    const blocks = await blocksUnder(dir);
    return blocks.length > 0;
  }, `no block under ${dir}`);
};

const smoke = async (): Promise<void> => {
  const clone = await makeClone();
  const created = await cli<CreateResult>('create', '--repo', clone, '--branch', 'feature/x');
  check(created.status === 'created', `create: status ${created.status}, not created`);
  check(created.tab?.opened === true, 'create: the tab did not open');
  await waitForBlock(created.path);
  const reused = await cli<CreateResult>('create', '--repo', clone, '--branch', 'feature/x');
  check(reused.status === 'reused', `create again: status ${reused.status}, not reused`);
  check(reused.tab?.opened === false, 'create again: a new tab opened');
  const listed = await cli<ListResult>('list');
  check(listed.worktrees.length === 1, `list: ${listed.worktrees.length} worktrees, not 1`);
  await cli('remove', created.path);
  check(!existsSync(created.path), `remove: ${created.path} still exists`);
  const blocksLeft = await blocksUnder(created.path);
  check(blocksLeft.length === 0, `remove: ${blocksLeft.length} blocks left under ${created.path}`);
};

mkdirSync(env.TERN_PLUGIN_DATA, { recursive: true });
mkdirSync(env.TERN_CONFIG_DIR, { recursive: true });
const daemon = spawn(ternBin(), ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { stdio: 'ignore' });
let spawnError: Error | undefined;
daemon.on('error', error => {
  spawnError = error;
});
try {
  await waitFor(() => {
    if (spawnError) {
      throw spawnError;
    }
    return existsSync(env.TERN_DAEMON_SOCKET);
  }, `no Tern daemon socket at ${env.TERN_DAEMON_SOCKET}`);
  await smoke();
  process.stdout.write('smoke ok\n');
} catch (error) {
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null && !spawnError) {
    const exited = once(daemon, 'exit');
    daemon.kill();
    await exited;
  }
  rmSync(tempRoot, { force: true, recursive: true });
}
