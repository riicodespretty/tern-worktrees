import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { repoRoot } from '../src/git.ts';
import type { TernBlock } from '../src/tern.ts';
import { blocksUnder, close, focus, ls, newSession, newTab, pluginLink, pluginLinked, rename, sessionForRepo, TERN_APP_BIN, ternBin } from '../src/tern.ts';
import type { Sandbox } from './helpers.ts';
import { FIXTURE_BIN, tempDir, ternLog, tmpRepo, useSandbox, writeTernListing } from './helpers.ts';

let sandbox: Sandbox;

const block = (id: number, cwd: string | null): TernBlock => ({ cwd, id, title: `block ${id}` });

describe('tern', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(ternBin, () => {
    it('prefers TERN_BIN, then the app bundle, then PATH', () => {
      expect(ternBin()).toBe(path.join(FIXTURE_BIN, 'tern'));
      vi.stubEnv('TERN_BIN', '');
      expect([ternBin(path.join(FIXTURE_BIN, 'gh')), ternBin('/nonexistent/tern')]).toStrictEqual([path.join(FIXTURE_BIN, 'gh'), 'tern']);
    });

    it('looks for the app bundle binary of the macOS install', () => {
      expect(TERN_APP_BIN).toBe('/Applications/Tern.app/Contents/MacOS/tern');
    });
  });

  describe('tern commands', () => {
    it('parses ls', async () => {
      const listing = { sessions: [{ id: 1, name: 'main', tabs: [{ blocks: [block(3, '/x')], id: 2, name: 'tab' }] }] };
      writeTernListing(listing);
      await expect(ls()).resolves.toStrictEqual(listing);
      expect(ternLog()).toStrictEqual(['ls --json']);
    });

    it('opens tabs and sessions and returns the block', async () => {
      await expect(newTab('main', '/work')).resolves.toBe(42);
      await expect(newSession('repo', '/work')).resolves.toBe(42);
      expect(ternLog()).toStrictEqual(['new tab main --cwd /work --json', 'new session repo --cwd /work --json']);
    });

    it('renames, focuses and closes blocks', async () => {
      await rename(42, 'feature/x');
      await focus(42);
      await close(42);
      expect(ternLog()).toStrictEqual(['rename 42 feature/x --json', 'focus 42 --json', 'close 42 --json']);
    });

    it.each([
      [
        'close',
        async () => {
          await close(1);
        },
      ],
      ['new', async () => await newTab('main', '/work')],
      ['new', async () => await newSession('repo', '/work')],
      [
        'rename',
        async () => {
          await rename(1, 'x');
        },
      ],
      [
        'focus',
        async () => {
          await focus(1);
        },
      ],
      ['ls', async () => await ls()],
    ])('raises tern_failed when %s fails', async (verb, call) => {
      vi.stubEnv('FAKE_TERN_FAIL', verb);
      await expect(call()).rejects.toMatchObject({ code: 'tern_failed', message: `fake tern: ${verb} failed` });
    });
  });

  describe(blocksUnder, () => {
    it('finds every block in or below a dir', async () => {
      const dir = tempDir('tern');
      const worktree = path.join(dir, 'wt');
      mkdirSync(path.join(worktree, 'sub'), { recursive: true });
      const main = { id: 1, name: 'main', tabs: [{ blocks: [block(10, worktree), block(11, dir), block(12, null), block(13, '')], id: 2, name: 'one' }] };
      const other = { id: 3, name: 'other', tabs: [{ blocks: [block(20, path.join(worktree, 'sub')), block(21, `${worktree}x`)], id: 4, name: 'two' }] };
      writeTernListing({ sessions: [main, other] });
      const found = await blocksUnder(worktree);
      expect(found.map(placed => [placed.session.name, placed.tab.id, placed.block.id])).toStrictEqual([
        ['main', 2, 10],
        ['other', 4, 20],
      ]);
    });
  });

  describe('blocks without a cwd', () => {
    it('are in no dir and no repository, not even the process cwd', async () => {
      const own = { id: 7, name: 'own', tabs: [{ blocks: [block(70, ''), block(71, null)], id: 8, name: 'x' }] };
      writeTernListing({ sessions: [own] });
      const cwdRoot = await repoRoot(process.cwd());
      expect(cwdRoot).not.toBeNull();
      await expect(Promise.all([blocksUnder(process.cwd()), sessionForRepo(String(cwdRoot))])).resolves.toStrictEqual([[], null]);
    });
  });

  describe(sessionForRepo, () => {
    it('gives the first session with a block in the repo', async () => {
      const repo = await tmpRepo();
      const otherRepo = await tmpRepo('other');
      const plain = tempDir('plain');
      const first = { id: 1, name: 'first', tabs: [{ blocks: [block(10, plain), block(11, null), block(12, ''), block(13, otherRepo.dir)], id: 2, name: 'a' }] };
      const second = { id: 3, name: 'second', tabs: [{ blocks: [block(20, plain), block(21, repo.dir)], id: 4, name: 'b' }] };
      const third = { id: 5, name: 'third', tabs: [{ blocks: [block(30, repo.dir)], id: 6, name: 'c' }] };
      writeTernListing({ sessions: [first, second, third] });
      await expect(Promise.all([sessionForRepo(repo.dir), sessionForRepo(otherRepo.dir), sessionForRepo(tempDir('none'))])).resolves.toStrictEqual([second, first, null]);
    });
  });

  describe(pluginLinked, () => {
    it('reads the link file, else a copied install, else null', async () => {
      expect(pluginLinked()).toBeNull();
      mkdirSync(path.join(sandbox.configDir, 'plugins', 'tern-worktrees'), { recursive: true });
      expect(pluginLinked()).toBe('installed');
      await pluginLink('/src/tern-worktrees');
      expect(ternLog()).toStrictEqual(['plugin link /src/tern-worktrees --json']);
      expect(pluginLinked()).toBe('/src/tern-worktrees');
    });

    it('raises tern_failed when linking fails', async () => {
      vi.stubEnv('FAKE_TERN_FAIL', 'plugin');
      await expect(pluginLink('/src')).rejects.toMatchObject({ code: 'tern_failed' });
      expect(pluginLinked()).toBeNull();
    });
  });
});
