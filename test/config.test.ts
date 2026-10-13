import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { loadConfig, setupCommands } from '../src/config.ts';
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
      expect(loadConfig()).toStrictEqual({ cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree+merged-branch' });
    });

    it('gives fresh default arrays', () => {
      loadConfig().hotkeys.new.push('x');
      write('{"hotkeys":{}}');
      loadConfig().hotkeys.new.push('y');
      expect(loadConfig().hotkeys.new).toStrictEqual(['cmd+shift+w']);
      write('{}');
      expect(loadConfig().hotkeys.new).toStrictEqual(['cmd+shift+w']);
    });

    it.each([
      ['{"teardown":"worktree"}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree' }],
      ['{"teardown":"worktree+merged-branch"}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree+merged-branch' }],
      [
        '{"cloneRoot":"/src","hotkeys":{"new":["ctrl+g","alt+w"]},"teardown":"worktree+branch"}',
        { cloneRoot: '/src', hotkeys: { new: ['ctrl+g', 'alt+w'] }, setup: {}, teardown: 'worktree+branch' },
      ],
      ['{"cloneRoot":"~/src"}', { cloneRoot: '/home/me/src', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree+merged-branch' }],
      ['{"hotkeys":{}}', { cloneRoot: '/home/me/Developer', hotkeys: { new: ['cmd+shift+w'] }, setup: {}, teardown: 'worktree+merged-branch' }],
      ['{"hotkeys":{"new":[]}}', { cloneRoot: '/home/me/Developer', hotkeys: { new: [] }, setup: {}, teardown: 'worktree+merged-branch' }],
      [
        '{"setup":{"Virtusize/Aoyama":["npm ci","npm test"],"me/empty":[]}}',
        {
          cloneRoot: '/home/me/Developer',
          hotkeys: { new: ['cmd+shift+w'] },
          setup: { 'me/empty': [], 'virtusize/aoyama': ['npm ci', 'npm test'] },
          teardown: 'worktree+merged-branch',
        },
      ],
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
      ['{"setup":[]}', 'setup: expected an object'],
      ['{"setup":null}', 'setup: expected an object'],
      ['{"setup":"npm ci"}', 'setup: expected an object'],
      ['{"setup":{"aoyama":["npm ci"]}}', 'setup.aoyama: expected <owner>/<name>'],
      ['{"setup":{"me/aoyama/x":["npm ci"]}}', 'setup.me/aoyama/x: expected <owner>/<name>'],
      ['{"setup":{"me/aoyama":"npm ci"}}', 'setup.me/aoyama: expected an array of non-empty strings'],
      ['{"setup":{"me/aoyama":["npm ci",3]}}', 'setup.me/aoyama: expected an array of non-empty strings'],
      ['{"setup":{"me/aoyama":["npm ci",""]}}', 'setup.me/aoyama: expected an array of non-empty strings'],
      ['{"setup":{"me/aoyama":["npm ci\\nnpm test"]}}', 'setup.me/aoyama: expected commands without line breaks'],
      ['{"setup":{"me/aoyama":["npm ci","npm test\\r"]}}', 'setup.me/aoyama: expected commands without line breaks'],
      ['{"setup":{"Me/Aoyama":["npm ci"],"me/aoyama":["npm test"]}}', 'setup.me/aoyama: duplicates setup.Me/Aoyama'],
      ['{"teardown":"worktree","extra":true}', 'extra: unknown key'],
    ])('rejects %s', (text, reason) => {
      write(text);
      expect(thrown()).toMatchObject({ code: 'config_invalid', message: `${file}: ${reason}` });
    });
  });

  describe(setupCommands, () => {
    it('matches the name with owner and ignores the difference between uppercase and lowercase letters', () => {
      write('{"setup":{"Virtusize/Aoyama":["npm ci","npm test"]}}');
      expect(setupCommands(loadConfig(), { name: 'aoyama', owner: 'VIRTUSIZE' })).toStrictEqual(['npm ci', 'npm test']);
    });

    it('gives an empty list for a repository without setup commands', () => {
      write('{"setup":{"Virtusize/Aoyama":["npm ci","npm test"]}}');
      expect(setupCommands(loadConfig(), { name: 'repo', owner: 'other' })).toStrictEqual([]);
    });

    it('gives an empty list for an empty command list', () => {
      write('{"setup":{"me/empty":[]}}');
      expect(setupCommands(loadConfig(), { name: 'empty', owner: 'me' })).toStrictEqual([]);
    });
  });
});
