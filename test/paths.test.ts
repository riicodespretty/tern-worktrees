import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envVar, expandHome, userHome, isUnder, ompRootDir, pluginData, slug, ternConfigDir, worktreeOwner, worktreePath, worktreeRoot } from '../src/paths.ts';
import type { OmpDirsEnv, WorktreeRoot } from '../src/paths.ts';
import { ompLog, tempDir, useOmp, useSandbox } from './helpers.ts';
import type { Sandbox } from './helpers.ts';

const DARWIN_TERN = '/home/me/Library/Application Support/Tern';

describe('paths', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = useSandbox();
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

  describe(worktreeRoot, () => {
    it('puts tern-managed worktrees under TERN_WT_HOME, also when omp is installed', async () => {
      useOmp({ base: '/omp-base', clone: true });
      vi.stubEnv('TERN_WT_HOME', '/wt');
      const root = await worktreeRoot();
      expect(root).toStrictEqual({ dir: '/wt/worktrees', omp: false });
      expect(worktreePath(root, 'aoyama', 'feature/x')).toBe('/wt/worktrees/aoyama/feature-x');
      expect(ompLog()).toStrictEqual([]);
    });

    it('defaults to ~/.tern-wt/worktrees without omp', async () => {
      vi.stubEnv('TERN_WT_HOME', '');
      await expect(worktreeRoot()).resolves.toStrictEqual({ dir: '/home/me/.tern-wt/worktrees', omp: false });
    });

    it('uses the omp root: OMP_WORKTREE_DIR, else worktree.base, else ~/.omp/wt', async () => {
      const home = useOmp({ base: '~/omp-base/', clone: false });
      await expect(worktreeRoot()).resolves.toStrictEqual({ dir: path.join(home, 'omp-base'), omp: true });
      vi.stubEnv('OMP_WORKTREE_DIR', '/from-env');
      await expect(worktreeRoot()).resolves.toMatchObject({ dir: '/from-env', omp: true });
      vi.stubEnv('OMP_WORKTREE_DIR', '~');
      await expect(worktreeRoot()).resolves.toMatchObject({ dir: home, omp: true });
      vi.stubEnv('OMP_WORKTREE_DIR', '');
      useOmp({ clone: false });
      await expect(worktreeRoot()).resolves.toMatchObject({ dir: path.join(process.env.HOME ?? '', '.omp', 'wt'), omp: true });
    });

    it('ignores a relative override', async () => {
      const home = useOmp({ base: 'relative/base', clone: false });
      vi.stubEnv('OMP_WORKTREE_DIR', 'relative/env');
      await expect(worktreeRoot()).resolves.toMatchObject({ dir: path.join(home, '.omp', 'wt'), omp: true });
      useOmp({ base: '/abs-base', clone: false });
      await expect(worktreeRoot()).resolves.toMatchObject({ dir: '/abs-base', omp: true });
    });

    it('fails closed with omp_failed when omp is installed but its config list fails', async () => {
      useOmp({ base: '/abs-base', clone: true });
      vi.stubEnv('FAKE_OMP_FAIL', 'config');
      await expect(worktreeRoot()).rejects.toMatchObject({
        code: 'omp_failed',
        message: 'omp config list failed: fake omp: config failed; the omp worktree root is unknown',
      });
    });

    it('fails closed with omp_failed when omp config list prints no JSON object', async () => {
      useOmp({ clone: true });
      writeFileSync(path.join(sandbox.ompDir, 'config.json'), 'not json');
      await expect(worktreeRoot()).rejects.toMatchObject({ code: 'omp_failed', message: 'omp config list printed no JSON object; the omp worktree root is unknown' });
    });
  });

  describe(ompRootDir, () => {
    const HOME = '/home/os';
    const at = (env: Record<string, string | undefined>, onDisk: string[] = [], platform: NodeJS.Platform = 'linux'): OmpDirsEnv => ({
      env,
      exists: target => onDisk.includes(target),
      home: HOME,
      platform,
    });

    it.each([
      ['/abs', '/abs'],
      ['  /with space/wt/  ', '/with space/wt'],
      ['/a//b/../c/', '/a/c'],
      ['~', HOME],
      ['~/', HOME],
      ['~/wt/', `${HOME}/wt`],
      ['~\\wt', `${HOME}\\wt`],
      ['/', '/'],
    ])('reads the override %j as %j', (value, expected) => {
      expect(ompRootDir(null, at({ OMP_WORKTREE_DIR: value }))).toBe(expected);
      expect(ompRootDir(value, at({}))).toBe(expected);
    });

    it.each(['', '   ', 'relative/wt', '~user/wt', './wt'])('skips the override %j', value => {
      expect(ompRootDir('/base', at({ OMP_WORKTREE_DIR: value }))).toBe('/base');
      expect(ompRootDir(value, at({}))).toBe(`${HOME}/.omp/wt`);
    });

    it('prefers OMP_WORKTREE_DIR to worktree.base', () => {
      expect(ompRootDir('/base', at({ OMP_WORKTREE_DIR: '/env' }))).toBe('/env');
    });

    it('puts the default root in the config dir, PI_CONFIG_DIR or .omp, of the home dir', () => {
      expect(ompRootDir(null, at({}))).toBe(`${HOME}/.omp/wt`);
      expect(ompRootDir(null, at({ PI_CONFIG_DIR: '.other' }))).toBe(`${HOME}/.other/wt`);
      expect(ompRootDir(null, at({ PI_CONFIG_DIR: '' }))).toBe(`${HOME}/.omp/wt`);
    });

    it.each([
      [{ OMP_PROFILE: 'work' }, `${HOME}/.omp/profiles/work/wt`],
      [{ OMP_PROFILE: ' work ' }, `${HOME}/.omp/profiles/work/wt`],
      [{ PI_PROFILE: 'legacy' }, `${HOME}/.omp/profiles/legacy/wt`],
      [{ OMP_PROFILE: 'work', PI_PROFILE: 'legacy' }, `${HOME}/.omp/profiles/work/wt`],
      [{ OMP_PROFILE: '', PI_PROFILE: 'legacy' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'default' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'Work' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'work.' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'con' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'lpt1.txt' }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'a'.repeat(65) }, `${HOME}/.omp/wt`],
      [{ OMP_PROFILE: 'work', PI_CONFIG_DIR: '.other' }, `${HOME}/.other/profiles/work/wt`],
    ])('resolves the profile of %j', (env, expected) => {
      expect(ompRootDir(null, at(env))).toBe(expected);
    });

    it('uses $XDG_DATA_HOME/omp on linux and darwin when it exists', () => {
      const env = { XDG_DATA_HOME: '/xdg' };
      expect(ompRootDir(null, at(env, ['/xdg/omp']))).toBe('/xdg/omp/wt');
      expect(ompRootDir(null, at(env, ['/xdg/omp'], 'darwin'))).toBe('/xdg/omp/wt');
      expect(ompRootDir(null, at(env, ['/xdg/omp'], 'win32'))).toBe(`${HOME}/.omp/wt`);
      expect(ompRootDir(null, at(env))).toBe(`${HOME}/.omp/wt`);
      expect(ompRootDir(null, at({ XDG_DATA_HOME: '' }, ['/omp']))).toBe(`${HOME}/.omp/wt`);
    });

    it('uses $XDG_DATA_HOME/omp/profiles/<profile> for a named profile only when that dir exists', () => {
      const env = { OMP_PROFILE: 'work', XDG_DATA_HOME: '/xdg' };
      expect(ompRootDir(null, at(env, ['/xdg/omp/profiles/work']))).toBe('/xdg/omp/profiles/work/wt');
      expect(ompRootDir(null, at(env, ['/xdg/omp']))).toBe(`${HOME}/.omp/profiles/work/wt`);
    });

    it('skips XDG when PI_CODING_AGENT_DIR moves the agent dir of the default profile', () => {
      const onDisk = ['/xdg/omp', '/xdg/omp/profiles/work'];
      expect(ompRootDir(null, at({ PI_CODING_AGENT_DIR: '/agent', XDG_DATA_HOME: '/xdg' }, onDisk))).toBe(`${HOME}/.omp/wt`);
      expect(ompRootDir(null, at({ PI_CODING_AGENT_DIR: `${HOME}/.omp/agent`, XDG_DATA_HOME: '/xdg' }, onDisk))).toBe('/xdg/omp/wt');
      expect(ompRootDir(null, at({ PI_CODING_AGENT_DIR: '', XDG_DATA_HOME: '/xdg' }, onDisk))).toBe('/xdg/omp/wt');
      expect(ompRootDir(null, at({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: '/agent', XDG_DATA_HOME: '/xdg' }, onDisk))).toBe('/xdg/omp/profiles/work/wt');
    });

    it('reads a PI_CODING_AGENT_DIR that a PI_PROFILE parent derived as no override', () => {
      const derived = `${HOME}/.omp/profiles/work/agent`;
      const env = { OMP_PROFILE: '', PI_CODING_AGENT_DIR: derived, PI_PROFILE: 'work', XDG_DATA_HOME: '/xdg' };
      expect(ompRootDir(null, at(env, ['/xdg/omp']))).toBe('/xdg/omp/wt');
      expect(ompRootDir(null, at({ ...env, PI_PROFILE: 'other' }, ['/xdg/omp']))).toBe(`${HOME}/.omp/wt`);
    });
  });

  describe(worktreeOwner, () => {
    const ompRoot: WorktreeRoot = { dir: '/omp/wt', omp: true };
    const ternRoot: WorktreeRoot = { dir: '/home/me/.tern-wt/worktrees', omp: false };

    it.each([
      [ompRoot, '/omp/wt/aoyama/feature-x', 'tern'],
      [ompRoot, '/omp/wt/aoyama/feature-x/', 'tern'],
      [ompRoot, '/omp/wt/7-abc1234', 'omp'],
      [ompRoot, '/omp/wt/other/feature-x', 'omp'],
      [ompRoot, '/omp/wt/aoyama/feature-x/deeper', 'omp'],
      [ompRoot, '/omp/wt', 'omp'],
      [ompRoot, '/elsewhere/aoyama/feature-x', null],
      [ternRoot, '/home/me/.tern-wt/worktrees/aoyama/feature-x', 'tern'],
      [ternRoot, '/home/me/.tern-wt/worktrees/other/feature-x', null],
    ])('owns the worktree under %j at %s: %s', (root, dir, expected) => {
      expect(worktreeOwner(root, '/src/aoyama', dir)).toBe(expected);
    });

    it('resolves symlinks of the root and the worktree', () => {
      const dir = tempDir('owner');
      mkdirSync(path.join(dir, 'real', 'aoyama', 'feature-x'), { recursive: true });
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      const root: WorktreeRoot = { dir: path.join(dir, 'link'), omp: true };
      expect(worktreeOwner(root, '/src/aoyama', path.join(dir, 'real', 'aoyama', 'feature-x'))).toBe('tern');
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
