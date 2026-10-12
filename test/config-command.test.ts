import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { main } from '../src/cli.ts';
import { run } from '../src/commands/config.ts';
import { loadConfig } from '../src/config.ts';
import { REPO_DIR, useSandbox } from './helpers.ts';

let file = '';

/** The list of the `DEFAULT_KEYS` literal in `window.luau`, the hotkeys default that the window half reads at load. */
const windowDefaultKeys = (): string[] => {
  const source = readFileSync(path.join(REPO_DIR, 'window.luau'), 'utf-8');
  const literal = /^local DEFAULT_KEYS = \{(?<keys>[^}]*)\}$/mu.exec(source)?.groups?.keys ?? '';
  return [...literal.matchAll(/"(?<key>[^"]*)"/gu)].map(match => match.groups?.key ?? '');
};

describe('config command', () => {
  beforeEach(() => {
    file = path.join(useSandbox().pluginData, 'config.json');
    vi.stubEnv('HOME', '/home/me');
  });

  it('gives the options with each default filled in without a file', () => {
    expect(run([])).toStrictEqual({ cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree+merged-branch' });
  });

  it('gives the values of the options file', () => {
    writeFileSync(file, JSON.stringify({ cloneRoot: '/src', hotkeys: { new: ['ctrl+g'] }, setup: { 'o/n': ['npm ci'] }, teardown: 'worktree+branch' }));
    expect(run([])).toStrictEqual({ cloneRoot: '/src', hotkeys: { new: ['ctrl+g'] }, setup: { 'o/n': ['npm ci'] }, teardown: 'worktree+branch' });
  });

  it('prints the options as one JSON line through main', async () => {
    writeFileSync(file, JSON.stringify({ teardown: 'worktree' }));
    await expect(main(['config'])).resolves.toStrictEqual({
      code: 0,
      stderr: '',
      stdout: `${JSON.stringify({ cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree' })}\n`,
    });
  });

  it('fails config_invalid through main on a bad options file', async () => {
    writeFileSync(file, JSON.stringify({ teardown: 'all' }));
    const message = `${file}: teardown: expected one of worktree, worktree+merged-branch, worktree+branch`;
    await expect(main(['config'])).resolves.toStrictEqual({
      code: 1,
      stderr: `${message}\n`,
      stdout: `${JSON.stringify({ error: { code: 'config_invalid', message } })}\n`,
    });
  });

  it('keeps the hotkeys default of window.luau equal to the default of the options file', () => {
    expect(windowDefaultKeys()).toStrictEqual(loadConfig().hotkeys.new);
  });
});
