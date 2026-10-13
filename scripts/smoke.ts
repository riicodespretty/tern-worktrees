import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CreateResult } from '../src/commands/create.ts';
import type { ListResult } from '../src/commands/list.ts';
import { gitMust } from '../src/git.ts';
import { run } from '../src/proc.ts';
import { blocksUnder, ls, ternBin } from '../src/tern.ts';
import { buildRepo } from './repo-fixture.ts';
import type { RepoFixture } from './repo-fixture.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt');
const smokeName = `twt-smoke-${Math.floor(Date.now() / 1000)}`;
const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'twt-smoke-'));
const env = {
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  GIT_TERMINAL_PROMPT: '0',
  TERN_CONFIG_DIR: path.join(tempRoot, 'tern-config'),
  TERN_DAEMON_SOCKET: path.join(tempRoot, 'tern.sock'),
  TERN_PLUGIN_DATA: path.join(tempRoot, 'plugin-data'),
  TERN_WT_HOME: path.join(tempRoot, 'home'),
  TERN_WT_OMP: path.join(tempRoot, 'no-omp'),
};
Object.assign(process.env, env);

const check = (ok: boolean, message: string): void => {
  if (!ok) {
    throw new Error(message);
  }
};

const cli = async <T>(...args: string[]): Promise<T> => {
  const result = await run([CLI, ...args]);
  check(result.status === 0, `tern-wt ${args.join(' ')} exited ${result.status}: ${result.stdout.trim()}`);
  // SAFETY: the CLI prints one JSON object for each command.
  return JSON.parse(result.stdout) as T;
};

const makeClone = async (): Promise<RepoFixture> => {
  const repo = await buildRepo(gitMust, tempRoot, smokeName, 'smoke\n');
  await repo.pushBranch('feature/x');
  return repo;
};

const POLL_MS = 100;

/** Calls `ready` at an interval of {@link POLL_MS} until it gives true, at most `attempts` times. `seconds` is the total wait in seconds that the failure message shows. */
const waitFor = async (ready: () => boolean | Promise<boolean>, what: string, attempts = 50, seconds = (attempts * POLL_MS) / 1000): Promise<void> => {
  if (await ready()) {
    return;
  }
  check(attempts > 1, `${what} after ${seconds}s`);
  await sleep(POLL_MS);
  await waitFor(ready, what, attempts - 1, seconds);
};

const waitForBlock = async (dir: string): Promise<void> => {
  await waitFor(async () => blocksUnder(await ls(), dir).length > 0, `no block under ${dir}`);
};

/** Runs `create` two times, `list` and `remove` on `feature/x` of a clone with setup commands. */
const smoke = async (): Promise<void> => {
  const repo = await makeClone();
  const clone = repo.dir;
  await gitMust(clone, 'remote', 'set-url', 'origin', 'https://github.com/smoke/twt-smoke.git');
  writeFileSync(path.join(env.TERN_PLUGIN_DATA, 'config.json'), JSON.stringify({ setup: { 'smoke/twt-smoke': ['touch .setup-ran'] } }));
  const created = await cli<CreateResult>('create', '--repo', clone, '--branch', 'feature/x');
  check(created.status === 'created', `create: status ${created.status}, not created`);
  check(created.tab?.opened === true, 'create: the tab did not open');
  check(created.setup?.typed === true, `create: setup ${JSON.stringify(created.setup)}, not typed; warnings ${created.warnings.join('; ')}`);
  await waitForBlock(created.path);
  const marker = path.join(created.path, '.setup-ran');
  await waitFor(() => existsSync(marker), `no ${marker}`, 300);
  process.stdout.write(`setup commands ran: ${marker}\n`);
  rmSync(marker);
  const reused = await cli<CreateResult>('create', '--repo', clone, '--branch', 'feature/x');
  check(reused.status === 'reused', `create again: status ${reused.status}, not reused`);
  check(reused.tab?.opened === false, 'create again: a new tab opened');
  check(reused.setup === null, `create again: setup ${JSON.stringify(reused.setup)}, not null`);
  const listed = await cli<ListResult>('list');
  check(listed.worktrees.length === 1, `list: ${listed.worktrees.length} worktrees, not 1`);
  await gitMust(clone, 'remote', 'set-url', 'origin', repo.origin);
  await cli('remove', created.path);
  check(!existsSync(created.path), `remove: ${created.path} still exists`);
  const blocksLeft = blocksUnder(await ls(), created.path);
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
