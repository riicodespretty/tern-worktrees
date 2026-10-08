import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { gitRun } from '../src/git.ts';
import {
  FIXTURE_BIN,
  ghFixture,
  ghLog,
  git,
  ignoreGlobally,
  ompConfigJson,
  ompLog,
  readLog,
  tempDir,
  ternLog,
  tmpRepo,
  useGithubOrigin,
  useOmp,
  useSandbox,
  writeTernLs,
  writeTernLsRaw,
} from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;
let originShimDir: string;

const managedPath = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const currentBranch = async (dir: string): Promise<string> => {
  const out = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out.trim();
};

const ompAdds = (): string[] => ompLog().filter(line => line.startsWith('worktree add'));

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
      await expect(run(['--nope'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
      await expect(run(['--nope'])).rejects.toThrow(/'--nope'/u);
      await expect(run(['--repo', repo.dir, '--branch', 'a', 'extra'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' });
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
      const merge = await gitRun(repo.dir, 'config', '--get', 'branch.feature/local.merge');
      expect(merge).toStrictEqual({ status: 1, stderr: '', stdout: '' });
    });

    it('fetches before the lookup', async () => {
      await git(repo.origin, 'branch', 'feature/late', 'main');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/late', '--no-tab'])).resolves.toMatchObject({ status: 'created', warnings: [] });
    });

    it('prunes the tracking branches that origin deleted', async () => {
      await repo.pushBranch('gone');
      await git(repo.dir, 'fetch', '--quiet', 'origin');
      await git(repo.origin, 'branch', '--quiet', '-D', 'gone');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created', warnings: [] });
      await expect(git(repo.dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone')).resolves.toBe('');
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
      originShimDir = await useGithubOrigin();
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
      expect(ghLog()).toContain('pr checkout 7 --branch pr-7');
      expect(readLog(cwdLog).at(-1)).toBe(managedPath('pr-7'));
      await expect(git(managedPath('pr-7'), 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'origin/main'));
    });

    it('applies the lookup rules to an existing pr-<n> worktree', async () => {
      prView(true);
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', managedPath('pr-7'));
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', status: 'reused' });
      expect(ghLog()).not.toContain('pr checkout 7 --branch pr-7');
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
      vi.stubEnv(
        'PATH',
        process.env.PATH?.split(':')
          .filter(dir => dir !== originShimDir)
          .join(':'),
      );
      await expect(run(['--repo', repo.dir, '--pr', '123', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: '--pr needs a GitHub origin' });
    });
  });

  describe('with omp', () => {
    let base: string;

    beforeEach(async () => {
      base = tempDir('omp-wt');
      await ignoreGlobally('.env');
      writeFileSync(path.join(repo.dir, '.env'), 'SECRET=1\n');
    });

    it('creates the worktree in the omp root through omp worktree add in clone mode', async () => {
      useOmp({ base, clone: true });
      const target = path.join(base, 'aoyama', 'feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toStrictEqual({
        branch: 'feature/x',
        carried: [],
        path: target,
        repo: repo.dir,
        status: 'created',
        tab: null,
        warnings: [],
      });
      expect(readFileSync(path.join(target, '.env'), 'utf-8')).toBe('SECRET=1\n');
      expect(ompAdds()).toStrictEqual([`worktree add -q -C ${repo.dir} ${target} feature/x`]);
      await expect(git(target, 'rev-parse', '--abbrev-ref', 'feature/x@{upstream}')).resolves.toBe('origin/feature/x\n');
      await expect(git(target, 'status', '--porcelain')).resolves.toBe('');
    });

    it.each([false, true])('gives a remote branch its upstream also with branch.autoSetupMerge=false, clone mode %s', async clone => {
      useOmp({ base, clone });
      await git(repo.dir, 'config', 'branch.autoSetupMerge', 'false');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(git(repo.dir, 'rev-parse', '--abbrev-ref', 'feature/x@{upstream}')).resolves.toBe('origin/feature/x\n');
    });

    it('adds a new branch, a local branch and a fork pull request through omp', async () => {
      useOmp({ base, clone: true });
      await git(repo.dir, 'branch', 'feature/local');
      await useGithubOrigin();
      prView(true);
      ghFixture(['pr', 'checkout', '7', '--branch', 'pr-7'], '');
      await run(['--repo', repo.dir, '--branch', 'feature/y', '--new', '--no-tab']);
      await run(['--repo', repo.dir, '--branch', 'feature/local', '--no-tab']);
      await run(['--repo', repo.dir, '--pr', '7', '--no-tab']);
      const at = (slug: string): string => path.join(base, 'aoyama', slug);
      expect(ompAdds()).toStrictEqual([
        `worktree add -q -C ${repo.dir} ${at('feature-y')} feature/y`,
        `worktree add -q -C ${repo.dir} ${at('feature-local')} feature/local`,
        `worktree add -q -C ${repo.dir} --detach ${at('pr-7')} origin/main`,
      ]);
      await expect(currentBranch(at('feature-y'))).resolves.toBe('feature/y');
      await expect(currentBranch(at('feature-local'))).resolves.toBe('feature/local');
      expect(ghLog()).toContain('pr checkout 7 --branch pr-7');
    });

    it.each([
      ['true', 'origin/main\n'],
      ['false', null],
    ])('gives --new the upstream that plain git gives with branch.autoSetupMerge=%s', async (setting, upstream) => {
      await git(repo.dir, 'config', 'branch.autoSetupMerge', setting);
      const upstreamOf = async (branch: string): Promise<string | null> => {
        const result = await gitRun(repo.dir, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`);
        return result.status === 0 ? result.stdout : null;
      };
      useOmp({ base, clone: false });
      await run(['--repo', repo.dir, '--branch', 'feature/plain', '--new', '--no-tab']);
      useOmp({ base, clone: true });
      await run(['--repo', repo.dir, '--branch', 'feature/clone', '--new', '--no-tab']);
      expect(ompAdds()).toStrictEqual([`worktree add -q -C ${repo.dir} ${path.join(base, 'aoyama', 'feature-clone')} feature/clone`]);
      await expect(upstreamOf('feature/plain')).resolves.toBe(upstream);
      await expect(upstreamOf('feature/clone')).resolves.toBe(upstream);
    });

    it('uses plain git in the omp root when clone mode is off', async () => {
      useOmp({ base, clone: false });
      const target = path.join(base, 'aoyama', 'feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'created', warnings: [] });
      expect(existsSync(path.join(target, '.env'))).toBeFalsy();
      expect(ompAdds()).toStrictEqual([]);
    });

    it('uses ~/.tern-wt/worktrees and plain git without omp', async () => {
      const home = useOmp({ base, clone: true });
      vi.stubEnv('TERN_WT_OMP', path.join(tempDir('none'), 'omp'));
      const target = path.join(home, '.tern-wt', 'worktrees', 'aoyama', 'feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'created', warnings: [] });
      expect(existsSync(path.join(target, '.env'))).toBeFalsy();
      expect(ompLog()).toStrictEqual([]);
    });

    it('reads clone mode from the project config, and the root from the global config only', async () => {
      useOmp({ base, clone: false });
      writeFileSync(path.join(repo.dir, '.fake-omp.json'), ompConfigJson({ base: tempDir('project-base'), clone: true }));
      const target = path.join(base, 'aoyama', 'feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'created' });
      expect(readFileSync(path.join(target, '.env'), 'utf-8')).toBe('SECRET=1\n');
    });

    it('passes the warnings of omp on, and deletes the new branch when omp worktree add fails', async () => {
      useOmp({ base, clone: true });
      vi.stubEnv('FAKE_OMP_WARN', 'clone failed; checked out instead');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ warnings: ['omp: clone failed; checked out instead'] });
      vi.stubEnv('FAKE_OMP_FAIL', 'worktree');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/y', '--new', '--no-tab'])).rejects.toMatchObject({ code: 'git_failed', message: 'fake omp: worktree failed' });
      await expect(gitRun(repo.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/y')).resolves.toMatchObject({ status: 1 });
      await git(repo.dir, 'branch', 'feature/local');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/local', '--no-tab'])).rejects.toMatchObject({ code: 'git_failed' });
      await expect(gitRun(repo.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/local')).resolves.toMatchObject({ status: 0 });
    });

    it('fails closed with omp_failed and adds no worktree when omp fails in /', async () => {
      const home = useOmp({ base, clone: true });
      vi.stubEnv('FAKE_OMP_FAIL', 'config');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({
        code: 'omp_failed',
        message: 'omp config list failed: fake omp: config failed; the omp worktree root is unknown',
      });
      expect(existsSync(path.join(home, '.tern-wt'))).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain('feature/x');
    });

    it('uses plain git in the omp root with a warning when omp fails in the repo only', async () => {
      useOmp({ base, clone: true });
      writeFileSync(path.join(repo.dir, '.fake-omp.json'), '{');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/y', '--new', '--no-tab'])).resolves.toMatchObject({
        path: path.join(base, 'aoyama', 'feature-y'),
        warnings: ['omp config list printed no JSON object'],
      });
      expect(ompAdds()).toStrictEqual([]);
    });

    it('opens an omp-owned worktree of the branch where it is, without --relocate', async () => {
      useOmp({ base, clone: true });
      const ompOwned = path.join(base, 'feature-x-abc1234');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', ompOwned, 'origin/feature/x');
      writeTernLs({ work: [repo.dir] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toStrictEqual({
        branch: 'feature/x',
        carried: [],
        path: ompOwned,
        repo: repo.dir,
        status: 'reused',
        tab: { block: 42, opened: true, session: 'work' },
        warnings: [],
      });
      expect(ternLog()).toContain(`new tab work --cwd ${ompOwned} --json`);
      expect(existsSync(path.join(base, 'aoyama', 'feature-x'))).toBeFalsy();
    });

    it('adds a worktree for a branch next to a detached omp-owned worktree', async () => {
      useOmp({ base, clone: false });
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', path.join(base, 'detached-abc1234'), 'origin/main');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: path.join(base, 'aoyama', 'feature-x'), status: 'created' });
    });

    describe('same-repo pull requests', () => {
      const ompCheckout = (): string => path.join(base, '7-abc1234');

      beforeEach(async () => {
        useOmp({ base, clone: false });
        await useGithubOrigin();
        prView(false);
        await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', ompCheckout(), 'origin/feature/x');
      });

      it('reuses the omp checkout on pr-<n> whose ompPrHeadRef is the head branch', async () => {
        await git(repo.dir, 'config', 'branch.pr-7.ompPrHeadRef', 'feature/x');
        writeTernLs({ work: [repo.dir] });
        await expect(run(['--repo', repo.dir, '--pr', '7'])).resolves.toStrictEqual({
          branch: 'pr-7',
          carried: [],
          path: ompCheckout(),
          repo: repo.dir,
          status: 'reused',
          tab: { block: 42, opened: true, session: 'work' },
          warnings: [],
        });
        expect(ternLog()).toContain('rename 42 pr-7 --json');
        expect(existsSync(path.join(base, 'aoyama', 'feature-x'))).toBeFalsy();
      });

      it('reuses the omp checkout on pr-<n> without ompPrHeadRef', async () => {
        await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', path: ompCheckout(), status: 'reused' });
      });

      it('adds a worktree when ompPrHeadRef names another branch', async () => {
        await git(repo.dir, 'config', 'branch.pr-7.ompPrHeadRef', 'feature/other');
        const target = path.join(base, 'aoyama', 'feature-x');
        await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', path: target, status: 'created' });
      });

      it('prefers a worktree of the head branch to the omp checkout', async () => {
        const target = path.join(base, 'aoyama', 'feature-x');
        await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', target, 'origin/feature/x');
        await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', path: target, status: 'reused' });
      });

      it('does not reuse a pr-<n> worktree outside the omp root', async () => {
        await git(repo.dir, 'worktree', 'move', ompCheckout(), path.join(tempDir('elsewhere'), 'pr-7'));
        await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', status: 'created' });
      });

      it('does not reuse an omp checkout of another branch', async () => {
        await git(ompCheckout(), 'branch', '-m', 'pr-8');
        const target = path.join(base, 'aoyama', 'feature-x');
        await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', path: target, status: 'created' });
      });
    });
  });

  describe('tabs', () => {
    it('opens a tab in the session of the repo', async () => {
      writeTernLs({ other: [tempDir('plain')], work: [repo.dir] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'work' }, warnings: [] });
      expect(ternLog()).toStrictEqual(['ls --json', 'ls --json', `new tab work --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('opens a session named after the repo', async () => {
      writeTernLs({});
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'aoyama' } });
      expect(ternLog()).toStrictEqual(['ls --json', 'ls --json', `new session aoyama --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('focuses the tab that already shows the worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      writeTernLs({ work: [repo.dir, path.join(managedPath('feature-x'), 'src')] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ status: 'reused', tab: { block: 2, opened: false, session: 'work' } });
      expect(ternLog()).toStrictEqual(['ls --json', 'focus 2 --json']);
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
      writeTernLsRaw('{');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).rejects.toBeInstanceOf(SyntaxError);
    });
  });
});
