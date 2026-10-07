import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './git.ts';
import { envVar, isUnder, PLUGIN_ID, ternConfigDir } from './paths.ts';
import { must } from './proc.ts';

/** A pane of a Tern tab, as `tern ls --json` prints it. */
export interface TernBlock {
  id: number;
  cwd: string | null;
  title: string;
}

/** A tab of a Tern session. */
export interface TernTab {
  id: number;
  name: string;
  blocks: TernBlock[];
}

/** A Tern session. */
export interface TernSession {
  id: number;
  name: string;
  tabs: TernTab[];
}

/** The output of `tern ls --json`. */
export interface TernListing {
  sessions: TernSession[];
}

/** A block with the session and tab that hold it. */
export interface PlacedBlock {
  session: TernSession;
  tab: TernTab;
  block: TernBlock;
}

interface Created {
  block: number;
}

/** Where the macOS app bundle keeps the Tern binary. */
export const TERN_APP_BIN = '/Applications/Tern.app/Contents/MacOS/tern';

/** The Tern binary: `$TERN_BIN`, else the binary of the app bundle when the bundle is on disk, else `tern` from `PATH`. */
export const ternBin = (appBin: string = TERN_APP_BIN): string => envVar('TERN_BIN') ?? (existsSync(appBin) ? appBin : 'tern');

const tern = async (args: string[]): Promise<string> => await must([ternBin(), ...args, '--json'], 'tern_failed');

/** All sessions, tabs and blocks of the Tern window. */
export const ls = async (): Promise<TernListing> =>
  // SAFETY: `tern ls --json` prints the TernListing layout.
  JSON.parse(await tern(['ls'])) as TernListing;

const newBlock = async (args: string[]): Promise<number> => {
  // SAFETY: `tern new --json` prints the id of the new block in the `block` field.
  const created = JSON.parse(await tern(['new', ...args])) as Created;
  return created.block;
};

/** Opens a tab in `session` at `cwd` and returns its block id. */
export const newTab = async (session: string, cwd: string): Promise<number> => await newBlock(['tab', session, '--cwd', cwd]);

/** Opens a session named `name` at `cwd` and returns its block id. */
export const newSession = async (name: string, cwd: string): Promise<number> => await newBlock(['session', name, '--cwd', cwd]);

/** Names the tab that holds `block`. */
export const rename = async (block: number, name: string): Promise<void> => {
  await tern(['rename', String(block), name]);
};

/** Shows `block` in all windows. */
export const focus = async (block: number): Promise<void> => {
  await tern(['focus', String(block)]);
};

/** Closes `block`. */
export const close = async (block: number): Promise<void> => {
  await tern(['close', String(block)]);
};

const placedBlocks = (listing: TernListing): PlacedBlock[] => listing.sessions.flatMap(session => session.tabs.flatMap(tab => tab.blocks.map(block => ({ block, session, tab }))));

const cwdOf = (block: TernBlock): string | null => (block.cwd === '' ? null : block.cwd);

/** All blocks whose `cwd` is `dir` or a directory in it. */
export const blocksUnder = async (dir: string): Promise<PlacedBlock[]> =>
  placedBlocks(await ls()).filter(({ block }) => {
    const cwd = cwdOf(block);
    return cwd !== null && isUnder(cwd, dir);
  });

/** The first session with a block whose `cwd` is in the repository at `root`, or null. Each distinct `cwd` resolves once. */
export const sessionForRepo = async (root: string): Promise<TernSession | null> => {
  const placed = placedBlocks(await ls());
  const cwds = [...new Set(placed.map(({ block }) => cwdOf(block)))];
  const roots = new Map(await Promise.all(cwds.map(async cwd => [cwd, cwd === null ? null : await repoRoot(cwd)] as const)));
  return placed.find(({ block }) => roots.get(cwdOf(block)) === root)?.session ?? null;
};

/** Where Tern loads the plugin from: the linked package directory, `"installed"` for a copied install, or null when Tern does not have the plugin. */
export const pluginLinked = (): string | null => {
  const plugins = path.join(ternConfigDir(), 'plugins');
  const pathFile = path.join(plugins, `${PLUGIN_ID}.path`);
  if (existsSync(pathFile)) {
    return readFileSync(pathFile, 'utf-8').trim();
  }
  return existsSync(path.join(plugins, PLUGIN_ID)) ? 'installed' : null;
};

/** Links the plugin package at `dir` into Tern. */
export const pluginLink = async (dir: string): Promise<void> => {
  await tern(['plugin', 'link', dir]);
};
