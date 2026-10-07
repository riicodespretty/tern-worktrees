import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { must } from '../src/proc.ts';
import { git, ignoreGlobally, tempDir, tmpRepo, useSandbox } from './helpers.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';

const SUBMODULE_REFUSED = 'recreated: git worktree move refused (fatal: working trees containing submodules cannot be moved or removed)';

let sandbox: Sandbox;
let repo: TmpRepo;

const managedPath = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const currentBranch = async (dir: string): Promise<string> => {
  const out = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out.trim();
};

const stagingDirs = (): string[] => readdirSync(sandbox.tmp).filter(name => name.startsWith('tern-wt-carry-'));

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

  describe('relocation', () => {
    it.each([
      ['inside', (): string => path.join(managedPath('feature-x'), 'inner')],
      ['above', (): string => path.dirname(managedPath('feature-x'))],
    ])('does not reuse a worktree %s the target path', async (_place, where) => {
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', where(), 'origin/feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({ code: 'worktree_exists_elsewhere', extra: { existing: where() } });
    });

    it('rejects a worktree elsewhere without --relocate', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({
        code: 'worktree_exists_elsewhere',
        extra: { existing: old, target: managedPath('feature-x') },
        message: `feature/x has a worktree at ${old}; pass --relocate to move it to ${managedPath('feature-x')}`,
      });
    });

    it('moves a worktree into the root', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).resolves.toMatchObject({ status: 'relocated', warnings: [] });
      expect(existsSync(old)).toBeFalsy();
      await expect(currentBranch(managedPath('feature-x'))).resolves.toBe('feature/x');
    });

    it('unlocks a locked worktree before the move', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x', '--lock');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).resolves.toMatchObject({ status: 'relocated', warnings: [] });
      expect(existsSync(old)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain('locked');
    });

    it('rejects a relocation onto an existing path and keeps the old worktree', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      mkdirSync(managedPath('feature-x'), { recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate', '--no-tab'])).rejects.toMatchObject({ code: 'path_conflict' });
      await expect(currentBranch(old)).resolves.toBe('feature/x');
    });

    it('rejects a dangling symbolic link at the target path', async () => {
      mkdirSync(path.dirname(managedPath('feature-x')), { recursive: true });
      symlinkSync(path.join(tempDir('gone'), 'missing'), managedPath('feature-x'));
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).rejects.toMatchObject({ code: 'path_conflict', extra: { path: managedPath('feature-x') } });
    });

    it('recreates a managed worktree whose dir is gone', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      rmSync(managedPath('feature-x'), { force: true, recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(currentBranch(managedPath('feature-x'))).resolves.toBe('feature/x');
    });

    it('leaves the stale record of another branch alone', async () => {
      const unmounted = await outsideWorktree('main', '-b', 'feature/b');
      rmSync(unmounted, { force: true, recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      rmSync(managedPath('feature-x'), { force: true, recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.toContain(`worktree ${unmounted}\n`);
    });

    it('creates the worktree when the one elsewhere is gone', async () => {
      const old = await outsideWorktree('origin/feature/x', '--track', '-b', 'feature/x');
      rmSync(old, { force: true, recursive: true });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      await expect(currentBranch(managedPath('feature-x'))).resolves.toBe('feature/x');
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(old);
    });

    describe('with submodules', () => {
      beforeEach(async () => {
        await pushSubmoduleBranch('feature/s');
      });

      const submoduleWorktree = async (): Promise<string> => {
        const old = await outsideWorktree('origin/feature/s', '--track', '-b', 'feature/s');
        await git(old, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
        return old;
      };

      const expectKept = async (old: string, files: string[]): Promise<void> => {
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab'])).rejects.toMatchObject({
          code: 'dirty_worktree',
          extra: { existing: old, files },
          message: `${old} has work that recreating it would lose`,
        });
        await expect(currentBranch(old)).resolves.toBe('feature/s');
        expect(existsSync(managedPath('feature-s'))).toBeFalsy();
      };

      it('stops on a dirty worktree that git refuses to move, and stages nothing', async () => {
        await ignoreGlobally('.env');
        const old = await submoduleWorktree();
        writeFileSync(path.join(old, 'junk.txt'), 'x\n');
        writeFileSync(path.join(old, '.env'), 'SECRET=1\n');
        await expectKept(old, ['?? junk.txt']);
        expect(existsSync(path.join(old, 'junk.txt'))).toBeTruthy();
        expect(stagingDirs()).toStrictEqual([]);
        await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain('locked');
      });

      it('stops on an untracked file that status.showUntrackedFiles hides', async () => {
        const old = await submoduleWorktree();
        await git(repo.dir, 'config', 'status.showUntrackedFiles', 'no');
        writeFileSync(path.join(old, 'notes.txt'), 'x\n');
        await expectKept(old, ['?? notes.txt']);
        expect(existsSync(path.join(old, 'notes.txt'))).toBeTruthy();
      });

      it('carries the ignored files that are hard to rebuild into the recreated worktree', async () => {
        allowFileProtocol();
        await ignoreGlobally('.env*', 'node_modules', 'tool.sh');
        const old = await submoduleWorktree();
        writeFileSync(path.join(old, '.env'), 'SECRET=1\n');
        writeFileSync(path.join(old, 'sub', '.env.local'), 'LOCAL=1\n');
        writeFileSync(path.join(old, 'tool.sh'), '#!/bin/sh\n', { mode: 0o700 });
        symlinkSync('.env', path.join(old, '.env.link'));
        mkdirSync(path.join(old, 'node_modules'));
        writeFileSync(path.join(old, 'node_modules', 'x.js'), 'x\n');
        const result = await run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab']);
        const target = managedPath('feature-s');
        const read = (file: string): string => readFileSync(path.join(target, file), 'utf-8');
        expect({
          carried: result.carried.toSorted(),
          env: read('.env'),
          link: readlinkSync(path.join(target, '.env.link')),
          local: read('sub/.env.local'),
          mode: statSync(path.join(target, 'tool.sh')).mode.toString(8).slice(-3),
          nodeModules: existsSync(path.join(target, 'node_modules')),
          old: existsSync(old),
          staging: stagingDirs(),
          status: result.status,
          warnings: result.warnings,
        }).toStrictEqual({
          carried: ['.env', '.env.link', 'sub/.env.local', 'tool.sh'],
          env: 'SECRET=1\n',
          link: '.env',
          local: 'LOCAL=1\n',
          mode: '700',
          nodeModules: false,
          old: false,
          staging: [],
          status: 'relocated',
          warnings: [SUBMODULE_REFUSED],
        });
      });

      it('keeps the staged copy of a carried file that the new worktree already has', async () => {
        allowFileProtocol();
        await ignoreGlobally('.env', 'secrets');
        const old = await submoduleWorktree();
        writeFileSync(path.join(old, '.env'), 'SECRET=1\n');
        mkdirSync(path.join(old, 'secrets'));
        writeFileSync(path.join(old, 'secrets', 'key'), 'KEY\n');
        writeFileSync(path.join(repo.dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho hook > .env\n', { mode: 0o755 });
        const result = await run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab']);
        const [staging] = stagingDirs();
        const stagingDir = path.join(sandbox.tmp, staging);
        expect(result).toMatchObject({
          carried: ['secrets/key'],
          status: 'relocated',
          warnings: [SUBMODULE_REFUSED, `not carried: .env exists in the new worktree; the old copy stays in ${stagingDir}`],
        });
        expect(readFileSync(path.join(managedPath('feature-s'), '.env'), 'utf-8')).toBe('hook\n');
        expect(readFileSync(path.join(managedPath('feature-s'), 'secrets', 'key'), 'utf-8')).toBe('KEY\n');
        expect(readFileSync(path.join(stagingDir, '.env'), 'utf-8')).toBe('SECRET=1\n');
      });

      it('keeps the staging dir and names it when copying a file back fails', async () => {
        allowFileProtocol();
        await ignoreGlobally('conf');
        const old = await submoduleWorktree();
        mkdirSync(path.join(old, 'conf'));
        writeFileSync(path.join(old, 'conf', 'key'), 'KEY\n');
        writeFileSync(path.join(repo.dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho x > conf\n', { mode: 0o755 });
        const failure = run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab']);
        await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
        const stagingDir = path.join(sandbox.tmp, stagingDirs()[0]);
        await expect(failure).rejects.toMatchObject({ extra: { staging: stagingDir } });
        await expect(failure).rejects.toThrow(`; the carried files stay in ${stagingDir}`);
        expect(readFileSync(path.join(stagingDir, 'conf', 'key'), 'utf-8')).toBe('KEY\n');
      });

      it('keeps the staging dir and the error code when recreating the worktree fails', async () => {
        await useGithubOrigin();
        prView(true);
        await ignoreGlobally('.env');
        const old = path.join(tempDir('orca'), 'wt');
        await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', old, 'origin/feature/s');
        await git(old, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
        writeFileSync(path.join(old, '.env'), 'SECRET=1\n');
        const failure = run(['--repo', repo.dir, '--pr', '7', '--relocate', '--no-tab']);
        await expect(failure).rejects.toMatchObject({ code: 'gh_failed' });
        const stagingDir = path.join(sandbox.tmp, stagingDirs()[0]);
        await expect(failure).rejects.toMatchObject({ extra: { staging: stagingDir } });
        await expect(failure).rejects.toThrow(`fake gh: no fixture; the carried files stay in ${stagingDir}`);
        expect(readFileSync(path.join(stagingDir, '.env'), 'utf-8')).toBe('SECRET=1\n');
      });

      it('stops on a submodule commit that no remote holds', async () => {
        const old = await submoduleWorktree();
        const sub = path.join(old, 'sub');
        await git(sub, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
        const commit = await git(sub, 'rev-parse', '--short', 'HEAD');
        await git(old, 'commit', '--quiet', '-am', 'bump sub');
        await expectKept(old, [`sub: unpushed ${commit.trim()}`]);
        await expect(git(sub, 'rev-parse', '--short', 'HEAD')).resolves.toBe(commit);
      });

      it('locks a locked worktree again when it stops', async () => {
        const old = await submoduleWorktree();
        await git(repo.dir, 'worktree', 'lock', '--reason', 'on usb', old);
        writeFileSync(path.join(old, 'junk.txt'), 'x\n');
        await expectKept(old, ['?? junk.txt']);
        await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.toContain('locked on usb');
      });

      it('recreates a clean worktree that git refuses to move', async () => {
        allowFileProtocol();
        const old = await submoduleWorktree();
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--relocate', '--no-tab'])).resolves.toMatchObject({
          carried: [],
          status: 'relocated',
          warnings: [SUBMODULE_REFUSED],
        });
        expect(existsSync(old)).toBeFalsy();
        await expect(currentBranch(managedPath('feature-s'))).resolves.toBe('feature/s');
        expect(existsSync(path.join(managedPath('feature-s'), 'sub', 'README.md'))).toBeTruthy();
      });

      it('warns when the submodule update fails and keeps the worktree', async () => {
        const result = await run(['--repo', repo.dir, '--branch', 'feature/s', '--no-tab']);
        expect(result.status).toBe('created');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^submodule update failed: .*transport 'file' not allowed.*\S$/su);
        await expect(currentBranch(managedPath('feature-s'))).resolves.toBe('feature/s');
        await expect(run(['--repo', repo.dir, '--branch', 'feature/s', '--no-tab'])).resolves.toMatchObject({ status: 'reused', warnings: [] });
      });
    });
  });
});
