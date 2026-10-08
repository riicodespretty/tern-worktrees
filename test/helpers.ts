import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vite-plus/test';
import { buildRepo, gitWith } from '../scripts/repo-fixture.ts';
import type { RepoFixture } from '../scripts/repo-fixture.ts';
import { must } from '../src/proc.ts';
import type { TernListing } from '../src/tern.ts';

/** The checkout that the tests run in. */
export const REPO_DIR = path.resolve(import.meta.dirname, '..');

/** The directory that holds the fake `gh`, `omp` and `tern`. */
export const FIXTURE_BIN = path.join(REPO_DIR, 'test', 'fixtures', 'bin');

const created: string[] = [];

let current: Sandbox | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  current = null;
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
export const git = gitWith();

/** The temporary directories and files of a test. */
export interface Sandbox {
  wtHome: string;
  pluginData: string;
  configDir: string;
  ternDir: string;
  ternLog: string;
  ghDir: string;
  ghLog: string;
  ompDir: string;
  ompLog: string;
  tmp: string;
}

const activeSandbox = (): Sandbox => {
  if (!current) {
    throw new Error('call useSandbox before the fake gh and tern helpers');
  }
  return current;
};

/** Stubs each environment variable that the CLI reads to a temporary directory or a fake. Call it in `beforeEach`. */
export const useSandbox = (): Sandbox => {
  const root = tempDir('sandbox');
  const sandbox: Sandbox = {
    configDir: path.join(root, 'tern-config'),
    ghDir: path.join(root, 'gh'),
    ghLog: path.join(root, 'gh.log'),
    ompDir: path.join(root, 'omp'),
    ompLog: path.join(root, 'omp.log'),
    pluginData: path.join(root, 'plugin-data'),
    ternDir: path.join(root, 'tern'),
    ternLog: path.join(root, 'tern.log'),
    tmp: path.join(root, 'tmp'),
    wtHome: path.join(root, 'tern-wt'),
  };
  for (const dir of [sandbox.configDir, sandbox.ghDir, sandbox.ompDir, sandbox.pluginData, sandbox.ternDir, sandbox.tmp]) {
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
  vi.stubEnv('TERN_WT_OMP', path.join(root, 'no-omp'));
  vi.stubEnv('FAKE_OMP_DIR', sandbox.ompDir);
  vi.stubEnv('FAKE_OMP_LOG', sandbox.ompLog);
  vi.stubEnv('FAKE_OMP_FAIL', '');
  vi.stubEnv('FAKE_OMP_WARN', '');
  for (const name of ['OMP_WORKTREE_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_DATA_HOME']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('TMPDIR', sandbox.tmp);
  vi.stubEnv('PATH', `${FIXTURE_BIN}:${process.env.PATH ?? ''}`);
  current = sandbox;
  return sandbox;
};

export type { RepoFixture } from '../scripts/repo-fixture.ts';

/** Builds a {@link RepoFixture} whose clone directory has the name `name`. Call it after {@link useSandbox}. */
export const tmpRepo = async (name = 'repo'): Promise<RepoFixture> => await buildRepo(git, tempDir('repo'), name, 'test\n');

/**
 * Puts a fake `git` first on `PATH`. It runs the shell `script`, and then passes the call to the git that was on `PATH` before the shim.
 * The script sees the arguments as `$1` and up, and `exit` in the script stops the call. Returns the directory of the fake.
 */
export const gitShim = async (script: string): Promise<string> => {
  const dir = tempDir('git-shim');
  const realGitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
  writeFileSync(path.join(dir, 'git'), `#!/bin/sh\n${script}\nexec '${realGitPath.trim()}' "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}:${process.env.PATH ?? ''}`);
  return dir;
};

/** Makes `git remote get-url origin` answer `repoUrl`, so the commands see a GitHub origin. Returns the directory of the fake git. */
export const useGithubOrigin = async (repoUrl = 'https://github.com/virtusize/aoyama.git'): Promise<string> =>
  await gitShim(`if [ "$3 $4 $5" = "remote get-url origin" ]; then echo '${repoUrl}'; exit 0; fi`);

/** Logs the arguments of each git call, one line for each call. Returns the log file for {@link readLog}. */
export const logGitCalls = async (): Promise<string> => {
  const log = path.join(tempDir('git-log'), 'git.log');
  await gitShim(`printf '%s\\n' "$*" >>'${log}'`);
  return log;
};

/** Reads the lines of a log file. Returns an empty list when the file is not there. */
export const readLog = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n') : []);

/** The lines that the fake `gh` logged, one for each call. */
export const ghLog = (): string[] => readLog(activeSandbox().ghLog);

/** The lines that the fake `tern` logged, one for each call. */
export const ternLog = (): string[] => readLog(activeSandbox().ternLog);

/** The lines that the fake `omp` logged, one for each call. */
export const ompLog = (): string[] => readLog(activeSandbox().ompLog);

/** The omp settings that {@link useOmp} gives the fake `omp`. */
export interface FakeOmpSettings {
  clone: boolean;
  base?: string;
}

/** The text that `omp config list --json` prints for `settings`. A setting without a value has no `value` key. */
export const ompConfigJson = (settings: FakeOmpSettings): string =>
  JSON.stringify({
    'worktree.base': settings.base === undefined ? { type: 'string' } : { type: 'string', value: settings.base },
    'worktree.clone': { type: 'boolean', value: settings.clone },
  });

/**
 * Installs the fake `omp` with `settings`, clears `TERN_WT_HOME`, and sets `HOME` to a temporary directory, so the omp worktree root applies.
 * Without `settings.base` the root is `<HOME>/.omp/wt`. Returns the home directory. Call it after {@link useSandbox}.
 */
export const useOmp = (settings: FakeOmpSettings): string => {
  const userHome = tempDir('home');
  writeFileSync(path.join(activeSandbox().ompDir, 'config.json'), ompConfigJson(settings));
  vi.stubEnv('TERN_WT_OMP', path.join(FIXTURE_BIN, 'omp'));
  vi.stubEnv('TERN_WT_HOME', '');
  vi.stubEnv('HOME', userHome);
  return userHome;
};

/** Makes the fake `gh` print `body` when it gets `args`. */
export const ghFixture = (args: string[], body: string): void => {
  const key = args.join('_').replaceAll(/[/ ]/gu, '_');
  writeFileSync(path.join(activeSandbox().ghDir, `${key}.json`), body);
};

/** Makes the fake `gh` answer the default-branch query for `nameWithOwner` with `branch`. */
export const ghDefaultBranchFixture = (nameWithOwner: string, branch: string): void => {
  ghFixture(['repo', 'view', nameWithOwner, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], `${branch}\n`);
};

/** Makes the fake `tern ls` print the text `content`, so a test can give it bad JSON. */
export const writeTernLsRaw = (content: string): void => {
  writeFileSync(path.join(activeSandbox().ternDir, 'ls.json'), content);
};

/** Makes the fake `tern ls` print `listing`. */
export const writeTernListing = (listing: TernListing): void => {
  writeTernLsRaw(JSON.stringify(listing));
};

/** Makes the fake `tern ls` list one session for each key of `dirsBySession`. Each directory gets one tab with one block. */
export const writeTernLs = (dirsBySession: Record<string, string[]>): void => {
  const allDirs = Object.values(dirsBySession).flat();
  const sessions = Object.entries(dirsBySession).map(([name, dirs], index) => ({
    id: index + 1,
    name,
    tabs: dirs.map(cwd => {
      const id = allDirs.indexOf(cwd) + 1;
      return { blocks: [{ cwd, id, title: 'sh' }], id, name: 'tab' };
    }),
  }));
  writeTernListing({ sessions });
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
