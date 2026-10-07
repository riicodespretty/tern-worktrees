import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'tern-worktrees';

/** The value of the env var `name`, with an empty value read as unset. */
export const envVar = (name: string): string | undefined => {
  const value = process.env[name];
  return value === '' ? undefined : value;
};

/** The home directory of the user: `$HOME`, else the one the OS reports. */
export const userHome = (): string => envVar('HOME') ?? homedir();

/** The `tern-wt` home directory: `$TERN_WT_HOME`, else `~/.tern-wt`. */
export const home = (): string => envVar('TERN_WT_HOME') ?? path.join(userHome(), '.tern-wt');

/** The worktree root, the directory that holds all managed worktrees. */
export const worktreeRoot = (): string => path.join(home(), 'worktrees');

/** The directory name of the worktree of a branch: the branch with each `/` made `-`. */
export const slug = (branch: string): string => branch.replaceAll('/', '-');

/** The managed worktree path of `branch` in the repository named `repoName`. */
export const worktreePath = (repoName: string, branch: string): string => path.join(worktreeRoot(), repoName, slug(branch));

const ternDir = (platform: NodeJS.Platform, xdgVar: 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME', xdgDefault: string): string => {
  const configured = envVar('TERN_CONFIG_DIR');
  if (configured !== undefined) {
    return configured;
  }
  if (platform === 'darwin') {
    return path.join(userHome(), 'Library', 'Application Support', 'Tern');
  }
  return path.join(envVar(xdgVar) ?? path.join(userHome(), xdgDefault), 'tern');
};

/** The Tern configuration directory: `$TERN_CONFIG_DIR`, else the platform default. */
export const ternConfigDir = (platform: NodeJS.Platform = process.platform): string => ternDir(platform, 'XDG_CONFIG_HOME', '.config');

/** The plugin data directory that holds the settings file: `$TERN_PLUGIN_DATA`, else in the Tern state directory. */
export const pluginData = (platform: NodeJS.Platform = process.platform): string =>
  envVar('TERN_PLUGIN_DATA') ?? path.join(ternDir(platform, 'XDG_STATE_HOME', path.join('.local', 'state')), 'plugin-data', PLUGIN_ID);

/** Expands a leading `~` to the home directory. */
export const expandHome = (target: string): string => {
  if (target === '~') {
    return userHome();
  }
  return target.startsWith('~/') ? path.join(userHome(), target.slice(2)) : target;
};

const realish = (target: string): string => {
  try {
    return realpathSync.native(target);
  } catch {
    return path.join(realish(path.dirname(target)), path.basename(target));
  }
};

/** Tells if `child` is `parent` or in it. It resolves symbolic links first, and it compares full path segments only. */
export const isUnder = (child: string, parent: string): boolean => {
  const realChild = realish(path.resolve(child));
  const realParent = realish(path.resolve(parent));
  const prefix = realParent.endsWith(path.sep) ? realParent : realParent + path.sep;
  return realChild === realParent || realChild.startsWith(prefix);
};
