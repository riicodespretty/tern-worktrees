import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/list.ts';
import { cliJson, contract, git, logGitCalls, readLog, tempDir, tmpRepo, useOmp, useSandbox } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

const worktreeRootDir = (): string => path.join(sandbox.wtHome, 'worktrees');

const addWorktree = async (target: RepoFixture, dirName: string, ...flags: string[]): Promise<string> => {
  const dir = path.join(worktreeRootDir(), path.basename(target.dir), dirName);
  await git(target.dir, 'worktree', 'add', '--quiet', ...flags, dir, 'origin/main');
  return dir;
};

describe('list command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
  });

  it('lists nothing when the worktree root is missing', async () => {
    await expect(run([])).resolves.toStrictEqual({ root: worktreeRootDir(), warnings: [], worktrees: [] });
  });

  it('lists the managed worktrees of every repo and skips other dirs', async () => {
    const other = await tmpRepo('maui');
    const clean = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    const detached = await addWorktree(repo, 'PR-7', '--detach');
    const dirty = await addWorktree(other, 'feature-y', '-b', 'feature/y');
    writeFileSync(path.join(dirty, 'junk.txt'), 'x\n');
    mkdirSync(path.join(worktreeRootDir(), 'aoyama', 'plain'));
    mkdirSync(path.join(clean, 'src'));
    writeFileSync(path.join(worktreeRootDir(), 'aoyama', 'note.txt'), 'x\n');
    symlinkSync(clean, path.join(worktreeRootDir(), 'aoyama', 'link'));
    await git(repo.dir, 'clone', '--quiet', repo.origin, path.join(worktreeRootDir(), 'aoyama', 'clone'));
    await expect(run([])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [],
      worktrees: [
        { branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: clean, repo: repo.dir },
        { branch: null, changed: 0, dirty: false, owner: 'tern', path: detached, repo: repo.dir },
        { branch: 'feature/y', changed: 1, dirty: true, owner: 'tern', path: dirty, repo: other.dir },
      ],
    });
  });

  it('does not look inside a checkout one level below the root', async () => {
    const clone = path.join(worktreeRootDir(), 'aoyama');
    await git(repo.dir, 'clone', '--quiet', repo.origin, clone);
    await git(clone, 'worktree', 'add', '--quiet', '-b', 'feature/x', path.join(clone, 'feature-x'), 'origin/main');
    await expect(run([])).resolves.toStrictEqual({ root: worktreeRootDir(), warnings: [], worktrees: [] });
  });

  it('does not look inside the checkout at the root of --repo', async () => {
    const clone = path.join(worktreeRootDir(), 'aoyama');
    await git(repo.dir, 'clone', '--quiet', repo.origin, clone);
    const inner = path.join(clone, 'feature-x');
    await git(clone, 'worktree', 'add', '--quiet', '-b', 'feature/x', inner, 'origin/main');
    const index = await git(inner, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    writeFileSync(index.trim(), 'not an index');
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({ root: worktreeRootDir(), warnings: [], worktrees: [] });
  });

  it('counts each changed file once', async () => {
    const dir = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    writeFileSync(path.join(dir, 'staged.txt'), 'x\n');
    await git(dir, 'add', 'staged.txt');
    writeFileSync(path.join(dir, 'staged.txt'), 'y\n');
    writeFileSync(path.join(dir, 'junk.txt'), 'x\n');
    await expect(run([])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [],
      worktrees: [{ branch: 'feature/x', changed: 2, dirty: true, owner: 'tern', path: dir, repo: repo.dir }],
    });
  });

  it('adds nothing with --all when the root is not the omp root', async () => {
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', path.join(worktreeRootDir(), '7-abc1234'), 'origin/main');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'wt/1', path.join(worktreeRootDir(), 'aoyama', 'plain', 'feature-z'), 'origin/main');
    await expect(run(['--all'])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [],
      worktrees: [{ branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir }],
    });
  });

  it('lists only the worktrees of --repo', async () => {
    const other = await tmpRepo('maui');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    await addWorktree(other, 'feature-y', '-b', 'feature/y');
    await expect(run(['--repo', mine])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [],
      worktrees: [{ branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir }],
    });
  });

  it('leaves out the worktrees of another repo with the same name under --repo', async () => {
    const twin = await tmpRepo('aoyama');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    await addWorktree(twin, 'feature-y', '-b', 'feature/y');
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [],
      worktrees: [{ branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir }],
    });
  });

  it('lists only the tern-managed worktrees in the omp root', async () => {
    const base = tempDir('omp-wt');
    useOmp({ base, clone: false });
    const mine = path.join(base, 'aoyama', 'feature-x');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', mine, 'origin/main');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', path.join(base, '7-abc1234'), 'origin/main');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'wt/1', path.join(base, 'sandbox', 'feature-z'), 'origin/main');
    await expect(run([])).resolves.toStrictEqual({
      root: base,
      warnings: [],
      worktrees: [{ branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir }],
    });
  });

  describe('with --all in the omp root', () => {
    let base: string;

    beforeEach(() => {
      base = tempDir('omp-wt');
      useOmp({ base, clone: false });
    });

    it('also lists the omp-owned worktrees at any depth, with a null branch for a detached HEAD', async () => {
      const mine = path.join(base, 'aoyama', 'feature-x');
      const shallow = path.join(base, '7-abc1234');
      const detached = path.join(base, '9-def5678');
      const deep = path.join(base, 'sandbox', 'feature-z');
      const deeper = path.join(base, 'sandbox', 'deep', 'feature-w');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', mine, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', shallow, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', detached, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'wt/1', deep, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'wt/2', deeper, 'origin/main');
      writeFileSync(path.join(deep, 'junk.txt'), 'x\n');
      await expect(run(['--all'])).resolves.toStrictEqual({
        root: base,
        warnings: [],
        worktrees: [
          { branch: 'pr-7', changed: 0, dirty: false, owner: 'omp', path: shallow, repo: repo.dir },
          { branch: null, changed: 0, dirty: false, owner: 'omp', path: detached, repo: repo.dir },
          { branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir },
          { branch: 'wt/2', changed: 0, dirty: false, owner: 'omp', path: deeper, repo: repo.dir },
          { branch: 'wt/1', changed: 1, dirty: true, owner: 'omp', path: deep, repo: repo.dir },
        ],
      });
    });

    it('does not look inside a worktree or a main checkout', async () => {
      const outer = path.join(base, '7-abc1234');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', outer, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'inner', path.join(outer, 'inner'), 'origin/main');
      const clone = path.join(base, 'clone');
      await git(repo.dir, 'clone', '--quiet', repo.origin, clone);
      await git(clone, 'worktree', 'add', '--quiet', '-b', 'nested', path.join(clone, 'nested'), 'origin/main');
      await expect(run(['--all'])).resolves.toStrictEqual({
        root: base,
        warnings: [],
        worktrees: [{ branch: 'pr-7', changed: 1, dirty: true, owner: 'omp', path: outer, repo: repo.dir }],
      });
    });

    it('lists only the worktrees of --repo', async () => {
      const other = await tmpRepo('maui');
      const mine = path.join(base, '7-abc1234');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'pr-7', mine, 'origin/main');
      await git(other.dir, 'worktree', 'add', '--quiet', '-b', 'pr-8', path.join(base, '8-def5678'), 'origin/main');
      await expect(run(['--all', '--repo', repo.dir])).resolves.toStrictEqual({
        root: base,
        warnings: [],
        worktrees: [{ branch: 'pr-7', changed: 0, dirty: false, owner: 'omp', path: mine, repo: repo.dir }],
      });
    });

    it('answers list --all through main as the contract fixture', async () => {
      const app = await tmpRepo('app');
      const feat = path.join(base, 'app', 'feat');
      const omp = path.join(base, '7-abc1234');
      await git(app.dir, 'worktree', 'add', '--quiet', '-b', 'feat', feat, 'origin/main');
      await git(app.dir, 'worktree', 'add', '--quiet', '--detach', omp, 'origin/main');
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        writeFileSync(path.join(feat, name), 'x\n');
      }
      await expect(cliJson(['list', '--all'])).resolves.toStrictEqual(contract('list-all', { feat, omp, repo: app.dir, root: base }));
    });
  });

  it('fails closed with omp_failed when omp fails, and does not list ~/.tern-wt/worktrees', async () => {
    useOmp({ clone: false });
    vi.stubEnv('FAKE_OMP_FAIL', 'config');
    await expect(run([])).rejects.toMatchObject({ code: 'omp_failed', message: 'omp config list failed: fake omp: config failed; the omp worktree root is unknown' });
  });

  it('rejects a --repo outside a repo', async () => {
    const plain = tempDir('plain');
    await expect(run(['--repo', plain])).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
  });

  it('rejects unknown options', async () => {
    await expect(run(['--nope'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    await expect(run(['--nope'])).rejects.toThrow(/'--nope'/u);
  });
});

describe('list command with a worktree that git cannot read', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
  });

  it('lists a worktree whose changes git cannot count with 0 changes and a warning, and with --repo runs no git in the worktrees of other repos', async () => {
    const other = await tmpRepo('maui');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    const broken = await addWorktree(other, 'feature-y', '-b', 'feature/y');
    const index = await git(broken, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    writeFileSync(index.trim(), 'not an index');
    writeFileSync(path.join(broken, 'junk.txt'), 'x\n');
    const listed = { branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: mine, repo: repo.dir };
    await expect(run([])).resolves.toStrictEqual({
      root: worktreeRootDir(),
      warnings: [`changed files not counted in ${broken}: fatal: ${index.trim()}: index file smaller than expected`],
      worktrees: [listed, { branch: 'feature/y', changed: 0, dirty: false, owner: 'tern', path: broken, repo: other.dir }],
    });
    const log = await logGitCalls();
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({ root: worktreeRootDir(), warnings: [], worktrees: [listed] });
    expect(readLog(log).filter(call => call.includes(broken))).toStrictEqual([]);
  });

  it('counts the changes without the submodules of a worktree with a broken submodule .git file, and warns', async () => {
    const sub = await tmpRepo('sub');
    await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', sub.dir, 'sub');
    await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
    await git(repo.dir, 'push', '--quiet', 'origin', 'main');
    const clean = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    const broken = await addWorktree(repo, 'feature-y', '-b', 'feature/y');
    cpSync(path.join(repo.dir, 'sub'), path.join(broken, 'sub'), { recursive: true });
    writeFileSync(path.join(broken, 'junk.txt'), 'x\n');
    const expected = {
      root: worktreeRootDir(),
      warnings: [`changed files not counted in ${broken}: fatal: not a git repository: sub/../.git/modules/sub`],
      worktrees: [
        { branch: 'feature/x', changed: 0, dirty: false, owner: 'tern', path: clean, repo: repo.dir },
        { branch: 'feature/y', changed: 1, dirty: true, owner: 'tern', path: broken, repo: repo.dir },
      ],
    };
    await expect(run([])).resolves.toStrictEqual(expected);
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual(expected);
  });
});
