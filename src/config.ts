import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandHome, pluginData } from './paths.ts';
import { CliError } from './proc.ts';

/** What closing a worktree tab removes: the worktree, plus the branch always or only once merged. */
export type Teardown = 'worktree' | 'worktree+merged-branch' | 'worktree+branch';

/** The plugin settings from `config.json` in the plugin data directory. */
export interface Config {
  teardown: Teardown;
  cloneRoot: string;
  hotkeys: { new: string[] };
}

const TEARDOWNS: readonly Teardown[] = ['worktree', 'worktree+merged-branch', 'worktree+branch'];

const DEFAULT_NEW_KEYS: readonly string[] = ['ctrl+b>w'];

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
  return isString(raw.cloneRoot) && raw.cloneRoot !== '' ? expandHome(raw.cloneRoot) : fail('cloneRoot', 'expected a non-empty string');
};

const readNewKeys = (raw: RawOptions, fail: Fail): string[] => {
  if (!('hotkeys' in raw)) {
    return [...DEFAULT_NEW_KEYS];
  }
  if (!isJsonObject(raw.hotkeys)) {
    return fail('hotkeys', 'expected an object');
  }
  rejectUnknownKeys(Object.keys(raw.hotkeys), ['new'], 'hotkeys.', fail);
  const hotkeys: RawHotkeys = raw.hotkeys;
  if (!('new' in hotkeys)) {
    return [...DEFAULT_NEW_KEYS];
  }
  return isStringList(hotkeys.new) ? hotkeys.new : fail('hotkeys.new', 'expected an array of strings');
};

const decode = (text: string, fail: Fail): RawOptions => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    return fail('(root)', `invalid JSON: ${String(error)}`);
  }
  return isJsonObject(decoded) ? decoded : fail('(root)', 'expected an object');
};

/**
 * Reads the settings file. A missing file gives the defaults, and each key in the file replaces its default.
 * Throws `config_invalid` on invalid JSON, an unknown key or an incorrect value.
 */
export const loadConfig = (): Config => {
  const file = path.join(pluginData(), 'config.json');
  const fail: Fail = (key, reason) => {
    throw new CliError('config_invalid', `${file}: ${key}: ${reason}`);
  };
  const raw = existsSync(file) ? decode(readFileSync(file).toString(), fail) : {};
  rejectUnknownKeys(Object.keys(raw), ['teardown', 'cloneRoot', 'hotkeys'], '', fail);
  return {
    cloneRoot: readCloneRoot(raw, fail),
    hotkeys: { new: readNewKeys(raw, fail) },
    teardown: readTeardown(raw, fail),
  };
};
