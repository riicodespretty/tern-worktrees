import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandHome, pluginData } from './paths.ts';
import { CliError } from './proc.ts';

/** What closing a worktree tab removes: the worktree only, the worktree and its branch when merged, or the worktree and its branch. */
export type Teardown = 'worktree' | 'worktree+merged-branch' | 'worktree+branch';

/** The plugin settings from `config.json` in the plugin data directory. */
export interface Config {
  teardown: Teardown;
  cloneRoot: string;
  hotkeys: { new: string[] };
}

const TEARDOWNS: readonly Teardown[] = ['worktree', 'worktree+merged-branch', 'worktree+branch'];

const DEFAULT_NEW_TAB_HOTKEYS: readonly string[] = ['cmd+shift+w'];

type Fail = (key: string, reason: string) => never;

interface RawOptions {
  teardown?: unknown;
  cloneRoot?: unknown;
  hotkeys?: unknown;
}

interface RawHotkeys {
  new?: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';

const isJsonObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

const rejectUnknownKeys = (keys: string[], known: readonly string[], prefix: string, fail: Fail): void => {
  const unknownKey = keys.find(key => !known.includes(key));
  if (unknownKey !== undefined) {
    fail(`${prefix}${unknownKey}`, 'unknown key');
  }
};

const readTeardown = (raw: RawOptions, fail: Fail): Teardown => {
  if (!('teardown' in raw)) {
    return 'worktree+merged-branch';
  }
  return TEARDOWNS.find(teardown => teardown === raw.teardown) ?? fail('teardown', `expected one of ${TEARDOWNS.join(', ')}`);
};

const readCloneRoot = (raw: RawOptions, fail: Fail): string => {
  if (!('cloneRoot' in raw)) {
    return expandHome('~/Developer');
  }
  if (!isString(raw.cloneRoot) || raw.cloneRoot === '') {
    return fail('cloneRoot', 'expected a non-empty string');
  }
  const cloneRoot = expandHome(raw.cloneRoot);
  return path.isAbsolute(cloneRoot) ? cloneRoot : fail('cloneRoot', 'expected an absolute path or a path that starts with ~');
};

const readNewTabHotkeys = (raw: RawOptions, fail: Fail): string[] => {
  if (!('hotkeys' in raw)) {
    return [...DEFAULT_NEW_TAB_HOTKEYS];
  }
  if (!isJsonObject(raw.hotkeys)) {
    return fail('hotkeys', 'expected an object');
  }
  rejectUnknownKeys(Object.keys(raw.hotkeys), ['new'], 'hotkeys.', fail);
  const hotkeys: RawHotkeys = raw.hotkeys;
  if (!('new' in hotkeys)) {
    return [...DEFAULT_NEW_TAB_HOTKEYS];
  }
  return isStringList(hotkeys.new) ? hotkeys.new : fail('hotkeys.new', 'expected an array of strings');
};

const decode = (file: string, fail: Fail): RawOptions => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(file).toString());
  } catch (error) {
    return fail('(root)', error instanceof SyntaxError ? `invalid JSON: ${String(error)}` : `cannot read: ${String(error)}`);
  }
  return isJsonObject(decoded) ? decoded : fail('(root)', 'expected an object');
};

/**
 * Reads the options file. A missing file gives the defaults, and each key in the file replaces its default.
 * Throws `config_invalid` on a file it cannot read, invalid JSON, an unknown key or an incorrect value.
 */
export const loadConfig = (): Config => {
  const file = path.join(pluginData(), 'config.json');
  const fail: Fail = (key, reason) => {
    throw new CliError('config_invalid', `${file}: ${key}: ${reason}`);
  };
  const raw = existsSync(file) ? decode(file, fail) : {};
  rejectUnknownKeys(Object.keys(raw), ['teardown', 'cloneRoot', 'hotkeys'], '', fail);
  return {
    cloneRoot: readCloneRoot(raw, fail),
    hotkeys: { new: readNewTabHotkeys(raw, fail) },
    teardown: readTeardown(raw, fail),
  };
};
