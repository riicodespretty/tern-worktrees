import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/branches.ts';
import { worktreePath } from '../src/paths.ts';
import { must } from '../src/proc.ts';
import type { Sandbox, TmpRepo } from './helpers.ts';
import { git, tempDir, tmpRepo, useSandbox } from './helpers.ts';

const PR_LIST = 'pr_list_--repo_me_aoyama_--state_open_--limit_200_--json_number,title,headRefName,isCrossRepository.json';

const PRS = [
  { headRefName: 'feature/x', isCrossRepository: false, number: 7, title: 'Add x' },
  { headRefName: 'patch-1', isCrossRepository: true, number: 9, title: 'Fork fix' },
];

let sandbox: Sandbox;

const commitBranch = async (repo: TmpRepo, branch: string, date: string): Promise<void> => {
  vi.stubEnv('GIT_COMMITTER_DATE', date);
  await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', branch);
  await git(repo.dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  await git(repo.dir, 'reset', '--quiet', '--hard', 'origin/main');
  vi.stubEnv('GIT_COMMITTER_DATE', undefined);
};

const githubOrigin = async (repo: TmpRepo): Promise<void> => {
  const ssh = path.join(tempDir('ssh'), 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec git upload-pack '${repo.origin}'\n`, { mode: 0o755 });
  vi.stubEnv('GIT_SSH_COMMAND', ssh);
  await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:me/aoyama.git');
};

describe('branches command', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(run, () => {
    it('lists remote branches newest first, open PRs and worktrees', async () => {
      const repo = await tmpRepo('aoyama');
      await commitBranch(repo, 'aaa', '2000-01-01T00:00:00Z');
      await commitBranch(repo, 'zzz', '2031-01-01T00:00:00Z');
      await commitBranch(repo, 'feature/x', '2030-01-01T00:00:00Z');
      await githubOrigin(repo);
      writeFileSync(path.join(sandbox.ghDir, PR_LIST), JSON.stringify(PRS));
      const managed = worktreePath('aoyama', 'feature/x');
      await git(repo.dir, 'worktree', 'add', '--quiet', managed, 'feature/x');
      const outside = path.join(tempDir('wt'), 'zzz');
      await git(repo.dir, 'worktree', 'add', '--quiet', outside, 'zzz');
      await expect(run(['--repo', repo.dir])).resolves.toStrictEqual({
        branches: ['zzz', 'feature/x', 'main', 'aaa'],
        default: 'main',
        name: 'aoyama',
        prs: [
          { branch: 'feature/x', fork: false, number: 7, title: 'Add x' },
          { branch: 'patch-1', fork: true, number: 9, title: 'Fork fix' },
        ],
        repo: repo.dir,
        warnings: [],
        worktrees: [
          { branch: 'main', managed: false, path: repo.dir },
          { branch: 'feature/x', managed: true, path: managed },
          { branch: 'zzz', managed: false, path: outside },
        ],
      });
    });

    it('lists local and origin branches once each, newest first', async () => {
      const repo = await tmpRepo('aoyama');
      await commitBranch(repo, 'feature/x', '2030-01-01T00:00:00Z');
      vi.stubEnv('GIT_COMMITTER_DATE', '2031-01-01T00:00:00Z');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'local');
      await git(repo.dir, 'branch', 'feature/local');
      await git(repo.dir, 'reset', '--quiet', '--hard', 'origin/main');
      vi.stubEnv('GIT_COMMITTER_DATE', undefined);
      await git(repo.dir, 'branch', 'feature/x', 'origin/feature/x');
      await git(repo.dir, 'tag', 'v1');
      const result = await run(['--repo', repo.dir]);
      expect(result.branches).toStrictEqual(['feature/local', 'feature/x', 'main']);
    });

    it('fetches with prune before it lists', async () => {
      const repo = await tmpRepo('aoyama');
      await repo.pushBranch('gone');
      await git(repo.dir, 'fetch', '--quiet', 'origin');
      await git(repo.origin, 'branch', '-D', 'gone');
      await repo.pushBranch('fresh');
      const result = await run(['--repo', repo.dir]);
      expect(result.branches.toSorted()).toStrictEqual(['fresh', 'main']);
      expect(result.prs).toStrictEqual([]);
      expect(result.warnings).toStrictEqual([]);
      expect(existsSync(sandbox.ghLog)).toBeFalsy();
    });

    it('warns and lists the known branches when the fetch fails', async () => {
      const repo = await tmpRepo('aoyama');
      await repo.pushBranch('feature/x');
      await git(repo.dir, 'fetch', '--quiet', 'origin');
      await git(repo.dir, 'remote', 'set-url', 'origin', path.join(tempDir('missing'), 'nope.git'));
      const result = await run(['--repo', repo.dir]);
      expect(result.branches.toSorted()).toStrictEqual(['feature/x', 'main']);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/^fetch failed: \S[\s\S]*\S$/u);
    });

    it('warns and gives no PRs when gh fails', async () => {
      const repo = await tmpRepo('aoyama');
      await githubOrigin(repo);
      const result = await run(['--repo', repo.dir]);
      expect(result.prs).toStrictEqual([]);
      expect(result.warnings).toStrictEqual(['pr list failed: fake gh: no fixture']);
    });

    it('lists local branches newest first without an origin', async () => {
      const repo = await tmpRepo('aoyama');
      await git(repo.dir, 'remote', 'remove', 'origin');
      vi.stubEnv('GIT_COMMITTER_DATE', '2030-01-01T00:00:00Z');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'new');
      await git(repo.dir, 'branch', 'newer');
      await git(repo.dir, 'reset', '--quiet', '--hard', 'HEAD~1');
      vi.stubEnv('GIT_COMMITTER_DATE', undefined);
      await git(repo.dir, 'branch', 'aaa');
      await git(repo.dir, 'tag', 'v1');
      const result = await run(['--repo', repo.dir]);
      expect(result.branches[0]).toBe('newer');
      expect({ branches: result.branches.toSorted(), default: result.default, prs: result.prs, warnings: result.warnings }).toStrictEqual({
        branches: ['aaa', 'main', 'newer'],
        default: 'main',
        prs: [],
        warnings: [],
      });
      expect(existsSync(sandbox.ghLog)).toBeFalsy();
    });

    it('accepts a dir inside the repo', async () => {
      const repo = await tmpRepo('aoyama');
      const worktree = path.join(tempDir('wt'), 'x');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'x', worktree);
      const result = await run(['--repo', worktree]);
      expect(result.repo).toBe(repo.dir);
      expect(result.name).toBe('aoyama');
    });

    it('raises bad_args without --repo', async () => {
      await expect(run([])).rejects.toMatchObject({ code: 'bad_args', message: 'branches needs --repo <dir>' });
    });

    it('raises not_a_repo outside a repo', async () => {
      const plain = tempDir('plain');
      await expect(run(['--repo', plain])).rejects.toMatchObject({ code: 'not_a_repo', message: `${plain} is not in a git repository` });
    });

    it('raises git_failed when git cannot list the branches', async () => {
      const repo = await tmpRepo('aoyama');
      const shimDir = tempDir('shim');
      const realGit = await must(['sh', '-c', 'command -v git'], 'git_failed');
      writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" for-each-ref "*) echo 'for-each-ref broke' >&2; exit 1;; esac\nexec '${realGit.trim()}' "$@"\n`, {
        mode: 0o755,
      });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      await expect(run(['--repo', repo.dir])).rejects.toMatchObject({ code: 'git_failed', message: 'for-each-ref broke' });
    });
  });
});
