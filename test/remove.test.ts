import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { must, run as runProcess } from '../src/proc.ts';
import { git, tempDir, tmpRepo, useSandbox } from './helpers.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';

let sandbox: Sandbox;
let repo: TmpRepo;

const managedPath = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n') : []);

const hasBranch = async (branch: string): Promise<boolean> => {
  const result = await runProcess(['git', '-C', repo.dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.status === 0;
};

const addManaged = async (flags: string[]): Promise<string> => {
  const dir = managedPath('feature-x');
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.dir, 'worktree', 'add', '--quiet', ...flags, dir, 'origin/feature/x');
  return dir;
};

const addFeature = async (): Promise<string> => await addManaged(['--track', '-b', 'feature/x']);

const addUnmerged = async (): Promise<string> => {
  const dir = await addFeature();
  await git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'wip');
  return dir;
};

const setTeardown = (teardown: string): void => {
  writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ teardown }));
};

const writeLs = (cwds: string[]): void => {
  const tabs = cwds.map((cwd, index) => ({ blocks: [{ cwd, id: index + 1, title: 'sh' }], id: index + 1, name: 'tab' }));
  writeFileSync(path.join(sandbox.ternDir, 'ls.json'), JSON.stringify({ sessions: [{ id: 1, name: 'work', tabs }] }));
};

const useGithubOrigin = async (): Promise<void> => {
  const shimDir = tempDir('shim');
  const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
  const shim = `#!/bin/sh\nif [ "$3 $4 $5" = "remote get-url origin" ]; then echo https://github.com/virtusize/aoyama.git; exit 0; fi\nexec '${gitPath.trim()}' "$@"\n`;
  writeFileSync(path.join(shimDir, 'git'), shim, { mode: 0o755 });
  vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
};

const logGitCalls = async (): Promise<string> => {
  const shimDir = tempDir('git-log');
  const log = path.join(shimDir, 'git.log');
  const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
  writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >>'${log}'\nexec '${gitPath.trim()}' "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
  return log;
};

const shimForcedRemove = async (action: string): Promise<void> => {
  const shimDir = tempDir('git-force');
  const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
  const shim = `#!/bin/sh\nif [ "$3 $4 $5 $6" = "worktree remove --force --force" ]; then ${action}; fi\nexec '${gitPath.trim()}' "$@"\n`;
  writeFileSync(path.join(shimDir, 'git'), shim, { mode: 0o755 });
  vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
};

const fakeMergedPrCount = (count: string): void => {
  const args = ['pr', 'list', '--repo', 'virtusize/aoyama', '--head', 'feature/x', '--state', 'merged', '--json', 'number', '--jq', 'length'];
  writeFileSync(path.join(sandbox.ghDir, `${args.join('_').replaceAll(/[/ ]/gu, '_')}.json`), `${count}\n`);
};

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeLs([]);
  });

  describe('arguments', () => {
    it.each([[[]], [['a', 'b']]])('rejects %j', async args => {
      await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message: 'remove needs one <path>' });
    });

    it('rejects unknown options', async () => {
      await expect(run(['--nope', 'x'])).rejects.toMatchObject({ code: 'bad_args' });
      await expect(run(['--nope', 'x'])).rejects.toThrow(/'--nope'/u);
    });

    it('rejects a path outside the worktree root', async () => {
      const outside = path.join(tempDir('outside'), 'x');
      await expect(run([outside])).rejects.toMatchObject({ code: 'not_managed', message: `${outside} is not under ${path.join(sandbox.wtHome, 'worktrees')}` });
    });

    it('rejects a dir under the root that is not in a repo', async () => {
      const plain = managedPath('plain');
      mkdirSync(plain, { recursive: true });
      await expect(run([plain])).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
    });

    it('rejects a dir inside a worktree', async () => {
      const dir = await addFeature();
      const inner = path.join(dir, 'src');
      mkdirSync(inner);
      await expect(run([inner, '--force'])).rejects.toMatchObject({
        code: 'not_managed',
        message: `${inner} is not the top directory of a linked worktree of ${repo.dir}`,
      });
      expect(existsSync(inner)).toBeTruthy();
    });

    it('rejects a main checkout under the root', async () => {
      const clone = managedPath('clone');
      await git(repo.dir, 'clone', '--quiet', repo.origin, clone);
      await expect(run([clone, '--force'])).rejects.toMatchObject({ code: 'not_managed' });
      expect(existsSync(clone)).toBeTruthy();
    });

    it('fails on an invalid options file before it removes anything', async () => {
      const dir = await addFeature();
      setTeardown('all');
      await expect(run([dir])).rejects.toMatchObject({ code: 'config_invalid' });
      expect(existsSync(dir)).toBeTruthy();
    });
  });

  describe('teardown policy', () => {
    it('deletes a branch that origin/main holds, and closes the tabs in the worktree', async () => {
      const dir = await addFeature();
      writeLs([repo.dir, dir, path.join(dir, 'src')]);
      await expect(run([dir])).resolves.toStrictEqual({ branch: 'feature/x', branchDeleted: true, closedBlocks: [2, 3], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
      await expect(hasBranch('feature/x')).resolves.toBeFalsy();
      expect(readLines(sandbox.ternLog).toSorted()).toStrictEqual(['close 2 --json', 'close 3 --json', 'ls --json']);
    });

    it('keeps an unmerged branch', async () => {
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: ['kept branch feature/x: not merged'] });
      expect(existsSync(dir)).toBeFalsy();
      await expect(hasBranch('feature/x')).resolves.toBeTruthy();
    });

    it('warns when the fetch fails and still checks origin/main', async () => {
      const dir = await addFeature();
      await git(repo.dir, 'remote', 'set-url', 'origin', path.join(tempDir('gone'), 'missing.git'));
      const result = await run([dir]);
      expect(result.branchDeleted).toBeTruthy();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/^fetch failed: fatal: .*missing\.git.*\S$/su);
    });

    it('deletes a squash-merged branch with a merged pull request', async () => {
      await useGithubOrigin();
      fakeMergedPrCount('1');
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: true, warnings: [] });
      await expect(hasBranch('feature/x')).resolves.toBeFalsy();
    });

    it('keeps a branch without a merged pull request', async () => {
      await useGithubOrigin();
      fakeMergedPrCount('0');
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: ['kept branch feature/x: not merged'] });
    });

    it('keeps the branch when gh fails', async () => {
      await useGithubOrigin();
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({
        branchDeleted: false,
        warnings: ['merged PR check failed: fake gh: no fixture', 'kept branch feature/x: not merged'],
      });
    });

    it('keeps the branch when the default branch is unknown', async () => {
      await useGithubOrigin();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'config', 'remote.origin.followRemoteHEAD', 'never');
      const dir = await addFeature();
      await expect(run([dir])).resolves.toMatchObject({
        branchDeleted: false,
        warnings: ['merge check failed: fake gh: no fixture', 'kept branch feature/x: not merged'],
      });
      await expect(hasBranch('feature/x')).resolves.toBeTruthy();
    });

    it('keeps the branch under the worktree policy', async () => {
      setTeardown('worktree');
      const dir = await addFeature();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: [] });
      await expect(hasBranch('feature/x')).resolves.toBeTruthy();
    });

    it('deletes an unmerged branch under the worktree+branch policy', async () => {
      setTeardown('worktree+branch');
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: true, warnings: [] });
      await expect(hasBranch('feature/x')).resolves.toBeFalsy();
    });

    it('warns when git refuses to delete the branch', async () => {
      setTeardown('worktree+branch');
      const dir = await addFeature();
      await git(repo.dir, 'worktree', 'add', '--quiet', '--force', path.join(tempDir('other'), 'wt'), 'feature/x');
      const result = await run([dir]);
      expect(result).toMatchObject({ branchDeleted: false, removed: dir });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/^branch feature\/x not deleted: error: .*feature\/x.*\S$/su);
    });

    it('leaves the branches alone for a detached worktree', async () => {
      setTeardown('worktree+branch');
      const dir = await addManaged(['--detach']);
      await expect(run([dir])).resolves.toStrictEqual({ branch: null, branchDeleted: false, closedBlocks: [], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
    });
  });

  describe('failures and --force', () => {
    it('keeps a dirty worktree and its tabs without --force', async () => {
      const dir = await addFeature();
      writeLs([dir]);
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'git_failed' });
      await expect(run([dir])).rejects.toThrow(/contains modified or untracked files.*\S$/su);
      expect(existsSync(path.join(dir, 'junk.txt'))).toBeTruthy();
      expect(readLines(sandbox.ternLog)).toStrictEqual(['ls --json', 'ls --json']);
    });

    it('removes a dirty worktree and closes its tabs with --force, and leaves other stale records alone', async () => {
      const stale = path.join(tempDir('stale'), 'wt');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', stale, 'main');
      rmSync(stale, { recursive: true });
      const dir = await addFeature();
      writeLs([dir]);
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      await expect(run([dir, '--force'])).resolves.toMatchObject({ closedBlocks: [1], removed: dir });
      expect(existsSync(dir)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.toContain(stale);
    });

    it('does not force a locked worktree without --force', async () => {
      const dir = await addFeature();
      await git(repo.dir, 'worktree', 'lock', dir);
      const log = await logGitCalls();
      const failure = run([dir]);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/locked/u);
      expect(existsSync(dir)).toBeTruthy();
      expect(readLines(log).join('\n')).not.toMatch(/remove --force|status --porcelain/u);
    });

    it('deletes a moved worktree with --force and prunes its record', async () => {
      const old = await addFeature();
      const moved = managedPath('moved');
      renameSync(old, moved);
      await expect(run([moved])).rejects.toThrow(/is not a working tree/u);
      await expect(run([moved, '--force'])).resolves.toMatchObject({ branch: 'feature/x', branchDeleted: true, removed: moved });
      expect(existsSync(moved)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(old);
    });

    it('goes on when git deletes the worktree and then fails', async () => {
      const dir = await addFeature();
      writeLs([dir]);
      await shimForcedRemove('rm -rf "$7"; exit 1');
      await expect(run([dir, '--force'])).resolves.toStrictEqual({ branch: 'feature/x', branchDeleted: true, closedBlocks: [1], removed: dir, warnings: [] });
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(dir);
    });

    it('deletes the worktree when git succeeds but leaves it', async () => {
      const dir = await addFeature();
      await shimForcedRemove('exit 0');
      await expect(run([dir, '--force'])).resolves.toMatchObject({ branchDeleted: true, removed: dir });
      expect(existsSync(dir)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.not.toContain(dir);
    });
  });

  describe('with submodules', () => {
    const subWorktree = async (): Promise<string> => {
      const sub = await tmpRepo('sub');
      await git(repo.dir, 'switch', '--quiet', '-c', 'feature/s');
      await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', sub.dir, 'sub');
      await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
      await git(repo.dir, 'push', '--quiet', 'origin', 'feature/s');
      await git(repo.dir, 'switch', '--quiet', 'main');
      await git(repo.dir, 'branch', '--quiet', '-D', 'feature/s');
      const dir = managedPath('feature-s');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/s', dir, 'origin/feature/s');
      await git(dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
      return dir;
    };

    it('removes a clean worktree without --force', async () => {
      const dir = await subWorktree();
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('keeps a worktree with changes inside a submodule', async () => {
      const dir = await subWorktree();
      writeFileSync(path.join(dir, 'sub', 'README.md'), 'changed\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'git_failed', message: 'fatal: working trees containing submodules cannot be moved or removed' });
      expect(readFileSync(path.join(dir, 'sub', 'README.md'), 'utf-8')).toBe('changed\n');
    });

    it('reports git refusing the forced removal of a clean worktree', async () => {
      const dir = await subWorktree();
      const sub = path.join(dir, 'sub');
      chmodSync(sub, 0o555);
      try {
        const failure = run([dir]);
        await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
        await expect(failure).rejects.toThrow(/failed to delete/u);
      } finally {
        chmodSync(sub, 0o755);
      }
    });
  });

  describe('tabs', () => {
    it('leaves the tabs alone under --keep-tab', async () => {
      const dir = await addFeature();
      writeLs([dir]);
      await expect(run([dir, '--keep-tab'])).resolves.toMatchObject({ closedBlocks: [], warnings: [] });
      expect(readLines(sandbox.ternLog)).toStrictEqual([]);
    });

    it('removes the worktree when Tern cannot list the blocks', async () => {
      const dir = await addFeature();
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['tabs not closed: fake tern: ls failed'] });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('warns for each block that Tern cannot close', async () => {
      const dir = await addFeature();
      writeLs([dir]);
      vi.stubEnv('FAKE_TERN_FAIL', 'close');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['block 1 not closed: fake tern: close failed'] });
    });

    it('passes on other errors before it removes anything', async () => {
      const dir = await addFeature();
      writeFileSync(path.join(sandbox.ternDir, 'ls.json'), '{');
      await expect(run([dir])).rejects.toBeInstanceOf(SyntaxError);
      expect(existsSync(dir)).toBeTruthy();
    });
  });
});
