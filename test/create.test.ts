import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { must, run as runProcess } from '../src/proc.ts';
import { FIXTURE_BIN, git, tempDir, tmpRepo, useSandbox } from './helpers.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';

let sandbox: Sandbox;
let repo: TmpRepo;

const managedPath = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const currentBranch = async (dir: string): Promise<string> => {
  const out = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out.trim();
};

const logLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n') : []);

const writeTernLs = (cwds: Record<string, string[]>): void => {
  const blocks = Object.values(cwds).flat();
  const sessions = Object.entries(cwds).map(([name, dirs], index) => ({
    id: index + 1,
    name,
    tabs: dirs.map(cwd => {
      const id = blocks.indexOf(cwd) + 1;
      return { blocks: [{ cwd, id, title: 'sh' }], id, name: 'tab' };
    }),
  }));
  writeFileSync(path.join(sandbox.ternDir, 'ls.json'), JSON.stringify({ sessions }));
};

const useGithubOrigin = async (): Promise<void> => {
  const shimDir = tempDir('shim');
  const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
  const shim = `#!/bin/sh\nif [ "$3 $4 $5" = "remote get-url origin" ]; then echo https://github.com/virtusize/aoyama.git; exit 0; fi\nexec '${gitPath.trim()}' "$@"\n`;
  writeFileSync(path.join(shimDir, 'git'), shim, { mode: 0o755 });
  vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
};

const ghFixture = (args: string[], body: string): void => {
  const key = args.join('_').replaceAll(/[/ ]/gu, '_');
  writeFileSync(path.join(sandbox.ghDir, `${key}.json`), body);
};

const prView = (fork: boolean): void => {
  ghFixture(
    ['pr', 'view', '7', '--repo', 'virtusize/aoyama', '--json', 'number,headRefName,isCrossRepository'],
    JSON.stringify({ headRefName: 'feature/x', isCrossRepository: fork, number: 7 }),
  );
};

describe('create command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
  });

  describe('arguments', () => {
    it.each([
      [['--branch', 'feature/x'], '--repo is required'],
      [['--repo', '.'], 'pass one of --branch or --pr'],
      [['--repo', '.', '--branch', 'a', '--pr', '7'], 'pass one of --branch or --pr'],
      [['--repo', '.', '--pr', '7', '--new'], '--new does not apply to --pr'],
      [['--repo', '.', '--pr', '07'], 'bad pull request number 07'],
      [['--repo', '.', '--pr', 'x7'], 'bad pull request number x7'],
      [['--repo', '.', '--pr', '7x'], 'bad pull request number 7x'],
    ])('rejects %j', async (args, message) => {
      await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message });
    });

    it('rejects unknown options and stray values', async () => {
      await expect(run(['--nope'])).rejects.toMatchObject({ code: 'bad_args' });
      await expect(run(['--nope'])).rejects.toThrow(/'--nope'/u);
      await expect(run(['--repo', repo.dir, '--branch', 'a', 'extra'])).rejects.toMatchObject({ code: 'bad_args' });
    });

    it('rejects a dir outside a repo', async () => {
      const plain = tempDir('plain');
      await expect(run(['--repo', plain, '--branch', 'feature/x'])).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
    });
  });

  describe('branches', () => {
    it('creates a tracking worktree for a remote branch, then reuses it', async () => {
      const target = managedPath('feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toStrictEqual({
        branch: 'feature/x',
        carried: [],
        path: target,
        repo: repo.dir,
        status: 'created',
        tab: null,
        warnings: [],
      });
      await expect(currentBranch(target)).resolves.toBe('feature/x');
      await expect(git(target, 'rev-parse', '--abbrev-ref', 'feature/x@{upstream}')).resolves.toBe('origin/feature/x\n');
      await expect(run(['--repo', target, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'reused', warnings: [] });
    });

    it('checks out an existing local branch', async () => {
      await git(repo.dir, 'branch', 'feature/local');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/local', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(currentBranch(managedPath('feature-local'))).resolves.toBe('feature/local');
      const merge = await runProcess(['git', '-C', repo.dir, 'config', '--get', 'branch.feature/local.merge']);
      expect(merge).toStrictEqual({ status: 1, stderr: '', stdout: '' });
    });

    it('fetches before the lookup', async () => {
      await git(repo.origin, 'branch', 'feature/late', 'main');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/late', '--no-tab'])).resolves.toMatchObject({ status: 'created', warnings: [] });
    });

    it('warns when the fetch fails and goes on', async () => {
      await git(repo.dir, 'remote', 'set-url', 'origin', path.join(tempDir('gone'), 'missing.git'));
      const result = await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      expect(result.status).toBe('created');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/^fetch failed: fatal: .*missing\.git.*\S$/su);
    });

    it('rejects a branch that does not exist', async () => {
      await expect(run(['--repo', repo.dir, '--branch', 'nope', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: 'no branch nope; pass --new to create it' });
      expect(existsSync(managedPath('nope'))).toBeFalsy();
    });

    it('rejects the branch of the main checkout', async () => {
      await expect(run(['--repo', repo.dir, '--branch', 'main', '--no-tab'])).rejects.toMatchObject({
        code: 'branch_in_main_checkout',
        extra: { existing: repo.dir },
        message: `main is checked out in the main checkout at ${repo.dir}`,
      });
    });

    it('rejects a target path that holds a plain dir', async () => {
      mkdirSync(managedPath('feature-x'), { recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({
        code: 'path_conflict',
        extra: { path: managedPath('feature-x') },
        message: `${managedPath('feature-x')} exists and is not the worktree of feature/x`,
      });
    });

    it('rejects a slug that collides with another branch', async () => {
      await repo.pushBranch('feature-x');
      await run(['--repo', repo.dir, '--branch', 'feature-x', '--no-tab']);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({ code: 'path_conflict' });
    });
  });

  describe('new branches', () => {
    it('creates a branch from the default branch of origin', async () => {
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/y', '--new', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/y', status: 'created' });
      const target = managedPath('feature-y');
      await expect(currentBranch(target)).resolves.toBe('feature/y');
      await expect(git(target, 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'origin/main'));
    });

    it('rejects a branch that exists on origin or locally', async () => {
      await git(repo.dir, 'branch', 'feature/local');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--new', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: 'branch feature/x already exists' });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/local', '--new', '--no-tab'])).rejects.toMatchObject({
        code: 'bad_args',
        message: 'branch feature/local already exists',
      });
    });

    it('reports git refusing to add the worktree', async () => {
      writeFileSync(path.join(repo.dir, '.git', 'worktrees'), '');
      const failure = run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/could not create leading directories/u);
    });

    it('bases the branch on the current branch without origin and skips the fetch', async () => {
      await git(repo.dir, 'remote', 'remove', 'origin');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/z', '--new', '--no-tab'])).resolves.toMatchObject({ status: 'created', warnings: [] });
      await expect(git(managedPath('feature-z'), 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'main'));
    });

    it.each([['bad..name'], ['-x'], ['HEAD']])('rejects the bad branch name %s and adds no worktree', async name => {
      await expect(run(['--repo', repo.dir, `--branch=${name}`, '--new', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: `bad branch name ${name}` });
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(sandbox.wtHome);
    });

    it('rejects a flag-shaped ref instead of reading it as an option', async () => {
      await git(repo.dir, 'update-ref', 'refs/heads/--detach', 'HEAD');
      await expect(run(['--repo', repo.dir, '--branch=--detach', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: 'bad branch name --detach' });
      expect(existsSync(managedPath('--detach'))).toBeFalsy();
    });

    it('rejects --new for a branch that already has a worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--new', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: 'branch feature/x already exists' });
      await expect(run(['--repo', repo.dir, '--branch', 'main', '--new', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: 'branch main already exists' });
    });
  });

  describe('pull requests', () => {
    beforeEach(async () => {
      await useGithubOrigin();
    });

    it('creates the worktree of a same-repo pull request', async () => {
      prView(false);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', path: managedPath('feature-x'), status: 'created' });
      await expect(currentBranch(managedPath('feature-x'))).resolves.toBe('feature/x');
    });

    it('checks out a fork pull request as pr-<n>', async () => {
      prView(true);
      ghFixture(['pr', 'checkout', '7', '--branch', 'pr-7'], '');
      const shimDir = tempDir('gh-shim');
      const cwdLog = path.join(shimDir, 'cwd.log');
      writeFileSync(path.join(shimDir, 'gh'), `#!/bin/sh\npwd -P >> '${cwdLog}'\nexec '${path.join(FIXTURE_BIN, 'gh')}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', path: managedPath('pr-7'), status: 'created', warnings: [] });
      expect(logLines(sandbox.ghLog)).toContain('pr checkout 7 --branch pr-7');
      expect(logLines(cwdLog).at(-1)).toBe(managedPath('pr-7'));
      await expect(git(managedPath('pr-7'), 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'origin/main'));
    });

    it('applies the lookup rules to an existing pr-<n> worktree', async () => {
      prView(true);
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', managedPath('pr-7'));
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', status: 'reused' });
      expect(logLines(sandbox.ghLog)).not.toContain('pr checkout 7 --branch pr-7');
    });

    it('reports a gh failure and removes the worktree of a failed fork checkout', async () => {
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
      prView(true);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed' });
      expect(existsSync(managedPath('pr-7'))).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(managedPath('pr-7'));
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });

    it('needs a GitHub origin', async () => {
      vi.stubEnv('PATH', process.env.PATH?.split(':').slice(1).join(':'));
      await expect(run(['--repo', repo.dir, '--pr', '123', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: '--pr needs a GitHub origin' });
    });
  });

  describe('tabs', () => {
    it('opens a tab in the session of the repo', async () => {
      writeTernLs({ other: [tempDir('plain')], work: [repo.dir] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'work' }, warnings: [] });
      expect(logLines(sandbox.ternLog)).toStrictEqual(['ls --json', 'ls --json', `new tab work --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('opens a session named after the repo', async () => {
      writeTernLs({});
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'aoyama' } });
      expect(logLines(sandbox.ternLog)).toStrictEqual(['ls --json', 'ls --json', `new session aoyama --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('focuses the tab that already shows the worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      writeTernLs({ work: [repo.dir, path.join(managedPath('feature-x'), 'src')] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ status: 'reused', tab: { block: 2, opened: false, session: 'work' } });
      expect(logLines(sandbox.ternLog)).toStrictEqual(['ls --json', 'focus 2 --json']);
    });

    it('keeps the worktree when Tern fails', async () => {
      writeTernLs({});
      vi.stubEnv('FAKE_TERN_FAIL', 'new');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        status: 'created',
        tab: null,
        warnings: ['tab not opened: fake tern: new failed'],
      });
      expect(existsSync(managedPath('feature-x'))).toBeTruthy();
    });

    it('passes on other errors', async () => {
      writeFileSync(path.join(sandbox.ternDir, 'ls.json'), '{');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).rejects.toBeInstanceOf(SyntaxError);
    });
  });
});
