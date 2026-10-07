import { mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envVar, expandHome, userHome, home, isUnder, pluginData, slug, ternConfigDir, worktreePath, worktreeRoot } from '../src/paths.ts';
import { tempDir, useSandbox } from './helpers.ts';

const DARWIN_TERN = '/home/me/Library/Application Support/Tern';

describe('paths', () => {
  beforeEach(() => {
    useSandbox();
    vi.stubEnv('HOME', '/home/me');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  describe(envVar, () => {
    it('reads an empty value as unset', () => {
      vi.stubEnv('TWT_PROBE', 'x');
      expect(envVar('TWT_PROBE')).toBe('x');
      vi.stubEnv('TWT_PROBE', '');
      expect(envVar('TWT_PROBE')).toBeUndefined();
    });
  });

  describe(userHome, () => {
    it('reads HOME at call time, else asks the OS', () => {
      expect(userHome()).toBe('/home/me');
      vi.stubEnv('HOME', '');
      expect(userHome()).toBe(homedir());
    });
  });

  describe(slug, () => {
    it.each([
      ['feature/x', 'feature-x'],
      ['a/b/c', 'a-b-c'],
      ['main', 'main'],
    ])('makes %s into %s', (branch, expected) => {
      expect(slug(branch)).toBe(expected);
    });
  });

  describe(worktreePath, () => {
    it('puts managed worktrees under TERN_WT_HOME', () => {
      vi.stubEnv('TERN_WT_HOME', '/wt');
      expect(home()).toBe('/wt');
      expect(worktreeRoot()).toBe('/wt/worktrees');
      expect(worktreePath('aoyama', 'feature/x')).toBe('/wt/worktrees/aoyama/feature-x');
    });

    it('defaults the home to ~/.tern-wt', () => {
      vi.stubEnv('TERN_WT_HOME', '');
      expect(home()).toBe('/home/me/.tern-wt');
    });
  });

  describe(ternConfigDir, () => {
    it.each([
      [{ TERN_CONFIG_DIR: '/cfg' }, 'linux', '/cfg'],
      [{ TERN_CONFIG_DIR: '/cfg' }, 'darwin', '/cfg'],
      [{ TERN_CONFIG_DIR: '' }, 'darwin', DARWIN_TERN],
      [{ TERN_CONFIG_DIR: '' }, 'linux', '/home/me/.config/tern'],
      [{ TERN_CONFIG_DIR: '', XDG_CONFIG_HOME: '/xdg' }, 'linux', '/xdg/tern'],
    ] as const)('with %j on %s gives %s', (env, platform, expected) => {
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }
      expect(ternConfigDir(platform)).toBe(expected);
    });

    it('defaults to the current platform', () => {
      vi.stubEnv('TERN_CONFIG_DIR', '');
      expect(ternConfigDir()).toBe(ternConfigDir(process.platform));
    });
  });

  describe(pluginData, () => {
    it.each([
      [{ TERN_PLUGIN_DATA: '/data' }, 'linux', '/data'],
      [{ TERN_CONFIG_DIR: '/cfg', TERN_PLUGIN_DATA: '' }, 'darwin', '/cfg/plugin-data/tern-worktrees'],
      [{ TERN_CONFIG_DIR: '', TERN_PLUGIN_DATA: '' }, 'darwin', `${DARWIN_TERN}/plugin-data/tern-worktrees`],
      [{ TERN_CONFIG_DIR: '', TERN_PLUGIN_DATA: '' }, 'linux', '/home/me/.local/state/tern/plugin-data/tern-worktrees'],
      [{ TERN_CONFIG_DIR: '', TERN_PLUGIN_DATA: '', XDG_CONFIG_HOME: '/xdg', XDG_STATE_HOME: '/state' }, 'linux', '/state/tern/plugin-data/tern-worktrees'],
    ] as const)('with %j on %s gives %s', (env, platform, expected) => {
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }
      expect(pluginData(platform)).toBe(expected);
    });

    it('defaults to the current platform', () => {
      vi.stubEnv('TERN_PLUGIN_DATA', '');
      vi.stubEnv('TERN_CONFIG_DIR', '');
      expect(pluginData()).toBe(pluginData(process.platform));
    });
  });

  describe(expandHome, () => {
    it.each([
      ['~', '/home/me'],
      ['~/Developer', '/home/me/Developer'],
      ['/abs/~/x', '/abs/~/x'],
      ['~other/x', '~other/x'],
      ['', ''],
    ])('expands %j to %j', (input, expected) => {
      expect(expandHome(input)).toBe(expected);
    });
  });

  describe(isUnder, () => {
    it.each([
      ['/a/b', '/a/b', true],
      ['/a/b/c', '/a/b', true],
      ['/a/bc', '/a/b', false],
      ['/a', '/a/b', false],
      ['/a/b', '/', true],
      ['/a/b/', '/a/b', true],
      ['/a/b', '/a/b/', true],
    ])('tells whether %s is under %s', (child, parent, expected) => {
      expect(isUnder(child, parent)).toBe(expected);
    });

    it('resolves symlinks, also for paths that do not exist yet', () => {
      const dir = tempDir('paths');
      mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      expect([
        isUnder(path.join(dir, 'link', 'sub'), path.join(dir, 'real')),
        isUnder(path.join(dir, 'link', 'missing', 'deeper'), path.join(dir, 'real')),
        isUnder(path.join(dir, 'real', 'sub'), path.join(dir, 'link')),
        isUnder(path.join(dir, 'other'), path.join(dir, 'link')),
      ]).toStrictEqual([true, true, true, false]);
    });
  });
});
