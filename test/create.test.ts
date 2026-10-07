import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { must, run as runProcess } from '../src/proc.ts';
import { FIXTURE_BIN, git, tempDir, tmpRepo, useSandbox } from './helpers.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';

const SUBMODULE_REFUSED = 'recreated: git worktree move refused (fatal: working trees containing submodules cannot be moved or removed)';

let sandbox: Sandbox;
let repo: TmpRepo;

const managed = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const head = async (dir: string): Promise<string> => {
  const out = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out.trim();
};

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n') : []);

const writeLs = (cwds: Record<string, string[]>): void => {
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

const allowFileProtocol = (): void => {
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.file.allow');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'always');
};

const outsideWorktree = async (branch: string, ...flags: string[]): Promise<string> => {
  const dir = path.join(tempDir('orca'), 'wt');
  await git(repo.dir, 'worktree', 'add', '--quiet', ...flags, dir, branch);
  return dir;
};

const pushSubmoduleBranch = async (branch: string): Promise<void> => {
  const sub = await tmpRepo('sub');
  await git(repo.dir, 'switch', '--quiet', '-c', branch);
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', sub.dir, 'sub');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
  await git(repo.dir, 'push', '--quiet', 'origin', branch);
  await git(repo.dir, 'switch', '--quiet', 'main');
  await git(repo.dir, 'branch', '--quiet', '-D', branch);
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
      const target = managed('feature-x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toStrictEqual({
        branch: 'feature/x',
        path: target,
        repo: repo.dir,
        status: 'created',
        tab: null,
        warnings: [],
      });
      await expect(head(target)).resolves.toBe('feature/x');
      await expect(git(target, 'rev-parse', '--abbrev-ref', 'feature/x@{upstream}')).resolves.toBe('origin/feature/x\n');
      await expect(run(['--repo', target, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'reused', warnings: [] });
    });

    it('checks out an existing local branch', async () => {
      await git(repo.dir, 'branch', 'feature/local');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/local', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(head(managed('feature-local'))).resolves.toBe('feature/local');
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
      expect(existsSync(managed('nope'))).toBeFalsy();
    });

    it('rejects the branch of the main checkout', async () => {
      await expect(run(['--repo', repo.dir, '--branch', 'main', '--no-tab'])).rejects.toMatchObject({
        code: 'branch_in_main_checkout',
        extra: { existing: repo.dir },
        message: `main is checked out in the main checkout at ${repo.dir}`,
      });
    });

    it('rejects a target path that holds a plain dir', async () => {
      mkdirSync(managed('feature-x'), { recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({
        code: 'path_conflict',
        extra: { path: managed('feature-x') },
        message: `${managed('feature-x')} exists and is not the worktree of feature/x`,
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
      const target = managed('feature-y');
      await expect(head(target)).resolves.toBe('feature/y');
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

    it('bases the branch on the current branch without origin and skips the fetch', async () => {
      await git(repo.dir, 'remote', 'remove', 'origin');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/z', '--new', '--no-tab'])).resolves.toMatchObject({ status: 'created', warnings: [] });
      await expect(git(managed('feature-z'), 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'main'));
    });

    it('reports a git failure', async () => {
      const args = ['--repo', repo.dir, '--branch', 'bad..name', '--new', '--no-tab'];
      await expect(run(args)).rejects.toMatchObject({ code: 'git_failed' });
      await expect(run(args)).rejects.toThrow(/'bad\.\.name' is not a valid branch name/u);
    });
  });

  describe('relocation', () => {
    it.each([
      ['inside', (): string => path.join(managed('feature-x'), 'inner')],
      ['above', (): string => path.dirname(managed('feature-x'))],
    ])('does not reuse a worktree %s the target path', async (_place, where) => {
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', where(), 'origin/feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({ code: 'worktree_exists_elsewhere', extra: { existing: where() } });
    });

    it('rejects a worktree elsewhere without --relocate', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({
        code: 'worktree_exists_elsewhere',
        extra: { existing: old, target: managed('feature-x') },
        message: `feature/x has a worktree at ${old}; pass --relocate to move it to ${managed('feature-x')}`,
      });
    });

    it('moves a worktree into the root', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).resolves.toMatchObject({ status: 'relocated', warnings: [] });
      expect(existsSync(old)).toBeFalsy();
      await expect(head(managed('feature-x'))).resolves.toBe('feature/x');
    });

    it('unlocks a locked worktree before the move', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x', '--lock');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).resolves.toMatchObject({ status: 'relocated', warnings: [] });
      expect(existsSync(old)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain('locked');
    });

    it('rejects a relocation onto an existing path and keeps the old worktree', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      mkdirSync(managed('feature-x'), { recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).rejects.toMatchObject({ code: 'path_conflict' });
      await expect(head(old)).resolves.toBe('feature/x');
    });

    describe('with submodules', () => {
      beforeEach(async () => {
        await pushSubmoduleBranch('feature/s');
      });

      const subWorktree = async (): Promise<string> => {
        const old = await outsideWorktree('origin/feature/s', '--track', '-b', 'feature/s');
        await git(old, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
        return old;
      };

      it('stops on a dirty worktree that git refuses to move', async () => {
        const old = await subWorktree();
        writeFileSync(path.join(old, 'junk.txt'), 'x\n');
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab'])).rejects.toMatchObject({
          code: 'dirty_worktree',
          extra: { existing: old, files: ['?? junk.txt'] },
          message: `${old} has uncommitted changes`,
        });
        expect(existsSync(path.join(old, 'junk.txt'))).toBeTruthy();
        expect(existsSync(managed('feature-s'))).toBeFalsy();
      });

      it('recreates a clean worktree that git refuses to move', async () => {
        allowFileProtocol();
        const old = await subWorktree();
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab'])).resolves.toMatchObject({
          status: 'relocated',
          warnings: [SUBMODULE_REFUSED],
        });
        expect(existsSync(old)).toBeFalsy();
        await expect(head(managed('feature-s'))).resolves.toBe('feature/s');
        expect(existsSync(path.join(managed('feature-s'), 'sub', 'README.md'))).toBeTruthy();
      });

      it('warns when the submodule update fails and keeps the worktree', async () => {
        const result = await run(['--repo', repo.dir, '--branch', 'feature/s', '--no-tab']);
        expect(result.status).toBe('created');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^submodule update failed: .*transport 'file' not allowed.*\S$/su);
        await expect(head(managed('feature-s'))).resolves.toBe('feature/s');
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--no-tab'])).resolves.toMatchObject({ status: 'reused', warnings: [] });
      });
    });
  });

  describe('pull requests', () => {
    beforeEach(async () => {
      await useGithubOrigin();
    });

    it('creates the worktree of a same-repo pull request', async () => {
      prView(false);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'feature/x', path: managed('feature-x'), status: 'created' });
      await expect(head(managed('feature-x'))).resolves.toBe('feature/x');
    });

    it('checks out a fork pull request as pr-<n>', async () => {
      prView(true);
      ghFixture(['pr', 'checkout', '7', '--branch', 'pr-7'], '');
      const shimDir = tempDir('gh-shim');
      const cwdLog = path.join(shimDir, 'cwd.log');
      writeFileSync(path.join(shimDir, 'gh'), `#!/bin/sh\npwd -P >> '${cwdLog}'\nexec '${path.join(FIXTURE_BIN, 'gh')}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', path: managed('pr-7'), status: 'created', warnings: [] });
      expect(lines(sandbox.ghLog)).toContain('pr checkout 7 --branch pr-7');
      expect(lines(cwdLog).at(-1)).toBe(managed('pr-7'));
      await expect(git(managed('pr-7'), 'rev-parse', 'HEAD')).resolves.toBe(await git(repo.dir, 'rev-parse', 'origin/main'));
    });

    it('applies the lookup rules to an existing pr-<n> worktree', async () => {
      prView(true);
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', managed('pr-7'));
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).resolves.toMatchObject({ branch: 'pr-7', status: 'reused' });
      expect(lines(sandbox.ghLog)).not.toContain('pr checkout 7 --branch pr-7');
    });

    it('reports a gh failure', async () => {
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
      prView(true);
      await expect(run(['--repo', repo.dir, '--pr', '7', '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed' });
    });

    it('needs a GitHub origin', async () => {
      vi.stubEnv('PATH', process.env.PATH?.split(':').slice(1).join(':'));
      await expect(run(['--repo', repo.dir, '--pr', '123', '--no-tab'])).rejects.toMatchObject({ code: 'bad_args', message: '--pr needs a GitHub origin' });
    });
  });

  describe('tabs', () => {
    it('opens a tab in the session of the repo', async () => {
      writeLs({ other: [tempDir('plain')], work: [repo.dir] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'work' }, warnings: [] });
      expect(lines(sandbox.ternLog)).toStrictEqual(['ls --json', 'ls --json', `new tab work --cwd ${managed('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('opens a session named after the repo', async () => {
      writeLs({});
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ tab: { block: 42, opened: true, session: 'aoyama' } });
      expect(lines(sandbox.ternLog)).toStrictEqual(['ls --json', 'ls --json', `new session aoyama --cwd ${managed('feature-x')} --json`, 'rename 42 feature/x --json']);
    });

    it('focuses the tab that already shows the worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      writeLs({ work: [repo.dir, path.join(managed('feature-x'), 'src')] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ status: 'reused', tab: { block: 2, opened: false, session: 'work' } });
      expect(lines(sandbox.ternLog)).toStrictEqual(['ls --json', 'focus 2 --json']);
    });

    it('keeps the worktree when Tern fails', async () => {
      writeLs({});
      vi.stubEnv('FAKE_TERN_FAIL', 'new');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        status: 'created',
        tab: null,
        warnings: ['tab not opened: fake tern: new failed'],
      });
      expect(existsSync(managed('feature-x'))).toBeTruthy();
    });

    it('passes on other errors', async () => {
      writeFileSync(path.join(sandbox.ternDir, 'ls.json'), '{');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).rejects.toBeInstanceOf(SyntaxError);
    });
  });
});
