import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { gitSucceeds } from '../src/git.ts';
import { ghFixture, git, gitShim, ignoreGlobally, logGitCalls, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs, writeTernLsRaw } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

const managedPath = (dirName: string): string => path.join(sandbox.wtHome, 'worktrees', 'aoyama', dirName);

const hasBranch = async (branch: string): Promise<boolean> => await gitSucceeds(repo.dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);

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

const shimForcedRemove = async (action: string): Promise<void> => {
  await gitShim(`if [ "$3 $4 $5 $6" = "worktree remove --force --force" ]; then ${action}; fi`);
};

const fakeMergedPrs = (headRefOids: string[]): void => {
  ghFixture(
    ['pr', 'list', '--repo', 'virtusize/aoyama', '--head=feature/x', '--state', 'merged', '--json', 'headRefOid'],
    JSON.stringify(headRefOids.map(headRefOid => ({ headRefOid }))),
  );
};

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('arguments', () => {
    it.each([[[]], [['a', 'b']]])('rejects %j', async args => {
      await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message: 'remove needs one <path>' });
    });

    it('rejects unknown options', async () => {
      await expect(run(['--nope', 'x'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
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

    it('rejects a path under the root that does not exist', async () => {
      const missing = managedPath('missing');
      await expect(run([missing])).rejects.toMatchObject({ code: 'not_a_repo', message: `${missing} is not in a git repository` });
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
      writeTernLs({ work: [repo.dir, dir, path.join(dir, 'src')] });
      await expect(run([dir])).resolves.toStrictEqual({ branch: 'feature/x', branchDeleted: true, closedBlocks: [2, 3], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
      await expect(hasBranch('feature/x')).resolves.toBeFalsy();
      expect(ternLog().toSorted()).toStrictEqual(['close 2 --json', 'close 3 --json', 'ls --json']);
    });

    it('keeps an unmerged branch', async () => {
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: ['kept local branch feature/x: not merged'] });
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

    it('fetches without pruning the tracking branches that origin deleted', async () => {
      const dir = await addFeature();
      await repo.pushBranch('gone');
      await git(repo.dir, 'fetch', '--quiet', 'origin');
      await git(repo.origin, 'branch', '--quiet', '-D', 'gone');
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: true, warnings: [] });
      await expect(git(repo.dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/gone')).resolves.toBe('refs/remotes/origin/gone\n');
    });

    it('deletes a squash-merged branch whose tip a merged pull request holds', async () => {
      await useGithubOrigin();
      const dir = await addUnmerged();
      const tip = await git(dir, 'rev-parse', 'HEAD');
      fakeMergedPrs(['0000000000000000000000000000000000000000', tip.trim()]);
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: true, warnings: [] });
      await expect(hasBranch('feature/x')).resolves.toBeFalsy();
    });

    it('keeps a branch with commits after its merged pull request', async () => {
      await useGithubOrigin();
      const dir = await addUnmerged();
      const merged = await git(dir, 'rev-parse', 'HEAD');
      fakeMergedPrs([merged.trim()]);
      await git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'follow-up after the merge');
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: ['kept local branch feature/x: not merged'] });
      await expect(hasBranch('feature/x')).resolves.toBeTruthy();
    });

    it('keeps a branch without a merged pull request', async () => {
      await useGithubOrigin();
      fakeMergedPrs([]);
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: false, warnings: ['kept local branch feature/x: not merged'] });
    });

    it('deletes a branch that shares its name with a tag', async () => {
      setTeardown('worktree+branch');
      await git(repo.dir, 'tag', 'v1', 'main');
      const dir = managedPath('v1');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'v1', dir, 'main');
      await expect(run([dir])).resolves.toMatchObject({ branch: 'v1', branchDeleted: true, warnings: [] });
      await expect(hasBranch('v1')).resolves.toBeFalsy();
    });

    it('keeps the branch when gh fails, and gives the kept branch first', async () => {
      await useGithubOrigin();
      const dir = await addUnmerged();
      await expect(run([dir])).resolves.toMatchObject({
        branchDeleted: false,
        warnings: ['kept local branch feature/x: not merged', 'merged PR check failed: fake gh: no fixture'],
      });
    });

    it('keeps the branch when the default branch is unknown', async () => {
      await useGithubOrigin();
      await git(repo.dir, 'remote', 'set-head', 'origin', '--delete');
      await git(repo.dir, 'config', 'remote.origin.followRemoteHEAD', 'never');
      const dir = await addFeature();
      await expect(run([dir])).resolves.toMatchObject({
        branchDeleted: false,
        warnings: ['kept local branch feature/x: not merged', 'merge check failed: fake gh: no fixture'],
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

    it('gives the not-deleted warning before an earlier warning', async () => {
      setTeardown('worktree+branch');
      const dir = await addFeature();
      await git(repo.dir, 'worktree', 'add', '--quiet', '--force', path.join(tempDir('other'), 'wt'), 'feature/x');
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      const result = await run([dir]);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toMatch(/^branch feature\/x not deleted: /u);
      expect(result.warnings[1]).toBe('tabs not closed: fake tern: ls failed');
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
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'git_failed' });
      await expect(run([dir])).rejects.toThrow(/contains modified or untracked files.*\S$/su);
      expect(existsSync(path.join(dir, 'junk.txt'))).toBeTruthy();
      expect(ternLog()).toStrictEqual(['ls --json', 'ls --json']);
    });

    it('keeps an untracked file that status.showUntrackedFiles hides', async () => {
      const dir = await addFeature();
      await git(repo.dir, 'config', 'status.showUntrackedFiles', 'no');
      writeFileSync(path.join(dir, 'draft.txt'), 'draft\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'git_failed' });
      expect(readFileSync(path.join(dir, 'draft.txt'), 'utf-8')).toBe('draft\n');
    });

    it('removes the real worktree when given a symbolic link to it', async () => {
      const dir = await addFeature();
      const alias = managedPath('alias');
      symlinkSync(dir, alias);
      await expect(run([alias, '--force'])).resolves.toMatchObject({ branch: 'feature/x', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('removes a dirty worktree and closes its tabs with --force, and leaves other stale records alone', async () => {
      const stale = path.join(tempDir('stale'), 'wt');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', stale, 'main');
      rmSync(stale, { recursive: true });
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      await expect(run([dir, '--force'])).resolves.toMatchObject({ closedBlocks: [1], removed: dir });
      expect(existsSync(dir)).toBeFalsy();
      await expect(git(repo.dir, 'worktree', 'list', '--porcelain')).resolves.toContain(stale);
    });

    it('does not force a locked worktree without --force', async () => {
      const dir = await addFeature();
      await git(repo.dir, 'worktree', 'lock', dir);
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      const failure = run([dir]);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/locked/u);
      expect(existsSync(dir)).toBeTruthy();
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
      writeTernLs({ work: [dir] });
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

    it('stops on ignored files that are hard to rebuild before git deletes them, and lists them with the other changes', async () => {
      await ignoreGlobally('.env', 'node_modules');
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x\n');
      await expect(run([dir])).rejects.toMatchObject({
        code: 'dirty_worktree',
        extra: { existing: dir, files: ['!! .env'] },
        message: `${dir} has work that removing it would lose`,
      });
      writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
      await expect(run([dir])).rejects.toMatchObject({ extra: { files: ['?? junk.txt', '!! .env'] } });
      expect(readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('SECRET=1\n');
      expect(ternLog()).toStrictEqual(['ls --json', 'ls --json']);
    });

    it('removes ignored files that are easy to rebuild without --force', async () => {
      await ignoreGlobally('node_modules', '.DS_Store');
      const dir = await addFeature();
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x\n');
      writeFileSync(path.join(dir, '.DS_Store'), 'x\n');
      await expect(run([dir])).resolves.toMatchObject({ removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('deletes ignored files that are hard to rebuild with --force', async () => {
      await ignoreGlobally('.env');
      const dir = await addFeature();
      writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
      await expect(run([dir, '--force'])).resolves.toMatchObject({ removed: dir });
      expect(existsSync(dir)).toBeFalsy();
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

    it('stops on an ignored file inside a submodule that is hard to rebuild', async () => {
      await ignoreGlobally('.env.local', 'node_modules');
      const dir = await subWorktree();
      writeFileSync(path.join(dir, 'sub', '.env.local'), 'SECRET=1\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { existing: dir, files: ['!! sub/.env.local'] } });
      expect(readFileSync(path.join(dir, 'sub', '.env.local'), 'utf-8')).toBe('SECRET=1\n');
      rmSync(path.join(dir, 'sub', '.env.local'));
      mkdirSync(path.join(dir, 'sub', 'node_modules'));
      writeFileSync(path.join(dir, 'sub', 'node_modules', 'x.js'), 'x\n');
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('removes a clean worktree without --force', async () => {
      const dir = await subWorktree();
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('keeps a worktree with changes inside a submodule', async () => {
      const dir = await subWorktree();
      writeFileSync(path.join(dir, 'sub', 'README.md'), 'changed\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { existing: dir, files: [' M sub', 'sub:  M README.md'] } });
      expect(readFileSync(path.join(dir, 'sub', 'README.md'), 'utf-8')).toBe('changed\n');
    });

    it('keeps a worktree whose submodule holds a commit that no remote has', async () => {
      setTeardown('worktree');
      const dir = await subWorktree();
      const sub = path.join(dir, 'sub');
      await git(sub, 'switch', '--quiet', '-c', 'local-work');
      await git(sub, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      const commit = await git(sub, 'rev-parse', '--short', 'HEAD');
      await git(dir, 'commit', '--quiet', '-am', 'bump sub');
      const log = await logGitCalls();
      await expect(run([dir])).rejects.toMatchObject({
        code: 'dirty_worktree',
        extra: { existing: dir, files: [`sub: unpushed ${commit.trim()}`] },
        message: `${dir} has work that removing it would lose`,
      });
      expect(readLog(log).join('\n')).not.toMatch(/remove --force/u);
      await expect(git(sub, 'rev-parse', '--short', 'local-work')).resolves.toBe(commit);
    });

    it('keeps an untracked file that status.showUntrackedFiles hides', async () => {
      const dir = await subWorktree();
      await git(repo.dir, 'config', 'status.showUntrackedFiles', 'no');
      writeFileSync(path.join(dir, 'draft.txt'), 'draft\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { files: ['?? draft.txt'] } });
      expect(existsSync(path.join(dir, 'draft.txt'))).toBeTruthy();
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
      writeTernLs({ work: [dir] });
      await expect(run([dir, '--keep-tab'])).resolves.toMatchObject({ closedBlocks: [], warnings: [] });
      expect(ternLog()).toStrictEqual([]);
    });

    it('removes the worktree when Tern cannot list the blocks', async () => {
      const dir = await addFeature();
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['tabs not closed: fake tern: ls failed'] });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('warns for each block that Tern cannot close', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'close');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['block 1 not closed: fake tern: close failed'] });
    });

    it('passes on other errors before it removes anything', async () => {
      const dir = await addFeature();
      writeTernLsRaw('{');
      await expect(run([dir])).rejects.toBeInstanceOf(SyntaxError);
      expect(existsSync(dir)).toBeTruthy();
    });
  });
});
