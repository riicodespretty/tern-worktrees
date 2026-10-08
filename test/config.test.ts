import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { loadConfig } from '../src/config.ts';
import { CliError } from '../src/proc.ts';
import { useSandbox } from './helpers.ts';

let file = '';

const write = (text: string): void => {
  writeFileSync(file, text);
};

const thrown = (): CliError | undefined => {
  try {
    loadConfig();
  } catch (error) {
    return error instanceof CliError ? error : undefined;
  }
  return undefined;
};

describe('config', () => {
  beforeEach(() => {
    file = path.join(useSandbox().pluginData, 'config.json');
    vi.stubEnv('HOME', '/home/me');
  });

  describe(loadConfig, () => {
    it('gives the defaults without a file', () => {
      expect(loadConfig()).toStrictEqual({ cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+alt+t'] }, teardown: 'worktree+merged-branch' });
    });

    it('gives fresh default arrays', () => {
      loadConfig().hotkeys.new.push('x');
      write('{"hotkeys":{}}');
      loadConfig().hotkeys.new.push('y');
      expect(loadConfig().hotkeys.new).toStrictEqual(['cmd+alt+t']);
      write('{}');
      expect(loadConfig().hotkeys.new).toStrictEqual(['cmd+alt+t']);
    });

    it.each([
      ['{"teardown":"worktree"}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+alt+t'] }, teardown: 'worktree' }],
      ['{"teardown":"worktree+merged-branch"}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+alt+t'] }, teardown: 'worktree+merged-branch' }],
      [
        '{"cloneRoot":"/src","hotkeys":{"new":["ctrl+g","alt+w"]},"teardown":"worktree+branch"}',
        { cloneRoot: '/src', hotkeys: { new: ['ctrl+g', 'alt+w'] }, teardown: 'worktree+branch' },
      ],
      ['{"cloneRoot":"~/src"}', { cloneRoot: '/home/me/src', hotkeys: { new: ['cmd+alt+t'] }, teardown: 'worktree+merged-branch' }],
      ['{"hotkeys":{}}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+alt+t'] }, teardown: 'worktree+merged-branch' }],
      ['{"hotkeys":{"new":[]}}', { cloneRoot: '/home/me/Developer', hotkeys: { new: [] }, teardown: 'worktree+merged-branch' }],
    ])('overrides only the keys in %s', (text, expected) => {
      write(text);
      expect(loadConfig()).toStrictEqual(expected);
    });

    it('rejects invalid JSON', () => {
      write('{not json');
      expect(thrown()?.message).toContain(`${file}: (root): invalid JSON: SyntaxError: `);
    });

    it('raises config_invalid when config.json is a directory', () => {
      mkdirSync(file);
      const error = thrown();
      expect(error?.code).toBe('config_invalid');
      expect(error?.message).toContain(`${file}: (root): cannot read: Error: EISDIR`);
    });

    it('raises config_invalid when config.json cannot be read', () => {
      write('{}');
      chmodSync(file, 0o000);
      const error = thrown();
      expect(error?.code).toBe('config_invalid');
      expect(error?.message).toContain(`${file}: (root): cannot read: Error: EACCES`);
    });

    it.each([
      ['[]', '(root): expected an object'],
      ['null', '(root): expected an object'],
      ['"text"', '(root): expected an object'],
      ['{"teardown":"all"}', 'teardown: expected one of worktree, worktree+merged-branch, worktree+branch'],
      ['{"teardown":1}', 'teardown: expected one of worktree, worktree+merged-branch, worktree+branch'],
      ['{"cloneRoot":""}', 'cloneRoot: expected a non-empty string'],
      ['{"cloneRoot":3}', 'cloneRoot: expected a non-empty string'],
      ['{"cloneRoot":"relative/dir"}', 'cloneRoot: expected an absolute path or a path that starts with ~'],
      ['{"cloneRoot":"~other/dir"}', 'cloneRoot: expected an absolute path or a path that starts with ~'],
      ['{"hotkeys":[]}', 'hotkeys: expected an object'],
      ['{"hotkeys":null}', 'hotkeys: expected an object'],
      ['{"hotkeys":"ctrl+b>w"}', 'hotkeys: expected an object'],
      ['{"hotkeys":{"new":"ctrl+b>w"}}', 'hotkeys.new: expected an array of strings'],
      ['{"hotkeys":{"new":["ctrl+b>w",2]}}', 'hotkeys.new: expected an array of strings'],
      ['{"hotkeys":{"new":[],"close":[]}}', 'hotkeys.close: unknown key'],
      ['{"teardown":"worktree","extra":true}', 'extra: unknown key'],
    ])('rejects %s', (text, reason) => {
      write(text);
      expect(thrown()).toMatchObject({ code: 'config_invalid', message: `${file}: ${reason}` });
    });
  });
});
