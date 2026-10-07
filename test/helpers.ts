import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vite-plus/test';
import { must } from '../src/proc.ts';

/** The checkout that the tests run in. */
export const REPO_DIR = path.resolve(import.meta.dirname, '..');

/** The directory that holds the fake `gh` and `tern`. */
export const FIXTURE_BIN = path.join(REPO_DIR, 'test', 'fixtures', 'bin');

const created: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** Makes a temporary directory, with symbolic links resolved, that the next `afterEach` removes. */
export const tempDir = (label: string): string => {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), `twt-${label}-`));
  created.push(dir);
  return dir;
};

/** Runs git in `cwd` and returns its `stdout`. */
export const git = async (cwd: string, ...args: string[]): Promise<string> => await must(['git', '-C', cwd, ...args], 'git_failed');

/** The temporary directories and files of a test. */
export interface Sandbox {
  wtHome: string;
  pluginData: string;
  configDir: string;
  ternDir: string;
  ternLog: string;
  ghDir: string;
  ghLog: string;
  tmp: string;
}

/** Stubs each environment variable that the CLI reads to a temporary directory or a fake. Call it in `beforeEach`. */
export const useSandbox = (): Sandbox => {
  const root = tempDir('sandbox');
  const sandbox: Sandbox = {
    configDir: path.join(root, 'tern-config'),
    ghDir: path.join(root, 'gh'),
    ghLog: path.join(root, 'gh.log'),
    pluginData: path.join(root, 'plugin-data'),
    ternDir: path.join(root, 'tern'),
    ternLog: path.join(root, 'tern.log'),
    tmp: path.join(root, 'tmp'),
    wtHome: path.join(root, 'tern-wt'),
  };
  for (const dir of [sandbox.configDir, sandbox.ghDir, sandbox.pluginData, sandbox.ternDir, sandbox.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  const gitConfig = path.join(root, 'gitconfig');
  writeFileSync(gitConfig, '');
  vi.stubEnv('TERN_WT_HOME', sandbox.wtHome);
  vi.stubEnv('TERN_PLUGIN_DATA', sandbox.pluginData);
  vi.stubEnv('TERN_CONFIG_DIR', sandbox.configDir);
  vi.stubEnv('TERN_BIN', path.join(FIXTURE_BIN, 'tern'));
  vi.stubEnv('FAKE_TERN_DIR', sandbox.ternDir);
  vi.stubEnv('FAKE_TERN_LOG', sandbox.ternLog);
  vi.stubEnv('FAKE_TERN_FAIL', '');
  vi.stubEnv('FAKE_GH_DIR', sandbox.ghDir);
  vi.stubEnv('FAKE_GH_LOG', sandbox.ghLog);
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('TMPDIR', sandbox.tmp);
  vi.stubEnv('PATH', `${FIXTURE_BIN}:${process.env.PATH ?? ''}`);
  return sandbox;
};

/** A temporary clone of a temporary bare `origin`, with one commit on `main` and `origin/HEAD` set. */
export interface TmpRepo {
  origin: string;
  dir: string;
  pushBranch: (name: string) => Promise<void>;
}

/** Builds a {@link TmpRepo} whose clone directory has the name `name`. Call it after {@link useSandbox}. */
export const tmpRepo = async (name = 'repo'): Promise<TmpRepo> => {
  const base = tempDir('repo');
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, name);
  await git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  await git(base, 'clone', '--quiet', origin, dir);
  await git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.md'), 'test\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '--quiet', '-m', 'initial');
  await git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  await git(dir, 'remote', 'set-head', 'origin', 'main');
  return {
    dir,
    origin,
    pushBranch: async (branch: string) => {
      await git(dir, 'push', '--quiet', 'origin', `main:refs/heads/${branch}`);
    },
  };
};

/** Makes git ignore `patterns` in each repository and submodule, through the global `core.excludesFile`. Call it after {@link useSandbox}. */
export const ignoreGlobally = async (...patterns: string[]): Promise<void> => {
  const excludes = path.join(tempDir('excludes'), 'ignore');
  writeFileSync(excludes, `${patterns.join('\n')}\n`);
  await git(path.dirname(excludes), 'config', '--global', 'core.excludesFile', excludes);
};

/** Runs `bin/tern-wt` with `args` and returns its exit status and output. */
export const spawnCli = (args: string[]) => {
  const result = spawnSync(path.join(REPO_DIR, 'bin', 'tern-wt'), args, { encoding: 'utf-8' });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
};
