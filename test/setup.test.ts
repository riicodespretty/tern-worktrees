import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as setup } from '../src/commands/setup.ts';
import type { Sandbox } from './helpers.ts';
import { REPO_DIR, tempDir, useSandbox } from './helpers.ts';

const PKG = realpathSync(REPO_DIR);

let sandbox: Sandbox;
let home: string;
let binLink: string;
let skillLink: string;

const binTarget = path.join(PKG, 'bin', 'tern-wt');
const skillTarget = path.join(PKG, 'skills', 'tern-worktrees');

const pluginPathFile = (): string => path.join(sandbox.configDir, 'plugins', 'tern-worktrees.path');

const ternLog = (): string[] => (existsSync(sandbox.ternLog) ? readFileSync(sandbox.ternLog).toString().trim().split('\n') : []);

const expectedLinks = (action: string): object[] => [
  { action, path: binLink, target: binTarget },
  { action, path: skillLink, target: skillTarget },
];

describe(setup, () => {
  beforeEach(() => {
    sandbox = useSandbox();
    home = tempDir('home');
    vi.stubEnv('HOME', home);
    binLink = path.join(home, '.local', 'bin', 'tern-wt');
    skillLink = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
  });

  it('links the plugin and makes both links, then keeps them on a second run', async () => {
    await expect(setup([])).resolves.toStrictEqual({ links: expectedLinks('created'), plugin: 'linked' });
    expect(readFileSync(pluginPathFile(), 'utf-8')).toBe(`${PKG}\n`);
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
    await expect(setup([])).resolves.toStrictEqual({ links: expectedLinks('kept'), plugin: 'already' });
    expect(ternLog()).toStrictEqual([`plugin link ${PKG} --json`]);
  });

  it('replaces a link to another target', async () => {
    const other = tempDir('other');
    for (const link of [binLink, skillLink]) {
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(other, link);
    }
    await expect(setup([])).resolves.toStrictEqual({ links: expectedLinks('replaced'), plugin: 'linked' });
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
  });

  it.each([
    ['another dir', '/elsewhere/tern-worktrees\n', '/elsewhere/tern-worktrees'],
    ['a copied install', undefined, 'installed'],
  ])('raises path_conflict when the plugin comes from %s, and changes nothing', async (_label, content, source) => {
    mkdirSync(path.join(sandbox.configDir, 'plugins', 'tern-worktrees'), { recursive: true });
    if (content !== undefined) {
      writeFileSync(pluginPathFile(), content);
    }
    await expect(setup([])).rejects.toMatchObject({
      code: 'path_conflict',
      extra: { path: source },
      message: `the tern-worktrees plugin comes from ${source}, not ${PKG}`,
    });
    expect([existsSync(binLink), existsSync(skillLink), ternLog()]).toStrictEqual([false, false, []]);
  });

  it.each([
    [
      'a regular file at the CLI link',
      (): string => binLink,
      (link: string): void => {
        writeFileSync(link, 'mine');
      },
      (link: string): boolean => readFileSync(link, 'utf-8') === 'mine',
    ],
    [
      'a dir at the skill link',
      (): string => skillLink,
      (link: string): void => {
        mkdirSync(link);
      },
      (link: string): boolean => lstatSync(link).isDirectory(),
    ],
  ])('raises path_conflict on %s and leaves it as it was', async (_label, linkPath, occupy, isUnchanged) => {
    const link = linkPath();
    mkdirSync(path.dirname(link), { recursive: true });
    occupy(link);
    await expect(setup([])).rejects.toMatchObject({ code: 'path_conflict', extra: { path: link }, message: `${link} exists and is not a symbolic link` });
    expect([lstatSync(link).isSymbolicLink(), existsSync(pluginPathFile()), ternLog()]).toStrictEqual([false, false, []]);
    expect(isUnchanged(link)).toBeTruthy();
  });

  it('rejects an unknown option', async () => {
    await expect(setup(['--nope'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
  });
});
