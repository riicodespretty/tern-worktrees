import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/list.ts';
import { git, tempDir, tmpRepo, useSandbox } from './helpers.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';

let sandbox: Sandbox;
let repo: TmpRepo;

const worktreeRootDir = (): string => path.join(sandbox.wtHome, 'worktrees');

const addWorktree = async (target: TmpRepo, dirName: string, ...flags: string[]): Promise<string> => {
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
    await expect(run([])).resolves.toStrictEqual({ root: worktreeRootDir(), worktrees: [] });
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
      worktrees: [
        { branch: 'feature/x', dirty: false, path: clean, repo: repo.dir },
        { branch: null, dirty: false, path: detached, repo: repo.dir },
        { branch: 'feature/y', dirty: true, path: dirty, repo: other.dir },
      ],
    });
  });

  it('lists only the worktrees of --repo', async () => {
    const other = await tmpRepo('maui');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    await addWorktree(other, 'feature-y', '-b', 'feature/y');
    await expect(run(['--repo', mine])).resolves.toStrictEqual({ root: worktreeRootDir(), worktrees: [{ branch: 'feature/x', dirty: false, path: mine, repo: repo.dir }] });
  });

  it('leaves out the worktrees of another repo with the same name under --repo', async () => {
    const twin = await tmpRepo('aoyama');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    await addWorktree(twin, 'feature-y', '-b', 'feature/y');
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({ root: worktreeRootDir(), worktrees: [{ branch: 'feature/x', dirty: false, path: mine, repo: repo.dir }] });
  });

  it('lists the worktrees of --repo when a worktree of another repo cannot be read', async () => {
    const other = await tmpRepo('maui');
    const mine = await addWorktree(repo, 'feature-x', '-b', 'feature/x');
    const broken = await addWorktree(other, 'feature-y', '-b', 'feature/y');
    const index = await git(broken, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    writeFileSync(index.trim(), 'not an index');
    await expect(run([])).rejects.toMatchObject({ code: 'git_failed' });
    await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({ root: worktreeRootDir(), worktrees: [{ branch: 'feature/x', dirty: false, path: mine, repo: repo.dir }] });
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
