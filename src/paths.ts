import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ompSettings } from './omp.ts';
import { CliError } from './proc.ts';

/** The id of the plugin in Tern. */
export const PLUGIN_ID = 'tern-worktrees';

/** The value of the env var `name`, with an empty value read as unset. */
export const envVar = (name: string): string | undefined => {
  const value = process.env[name];
  return value === '' ? undefined : value;
};

/** The home directory of the user: `$HOME`, else the one the OS reports. */
export const userHome = (): string => envVar('HOME') ?? homedir();

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

/** The plugin data directory that holds the options file: `$TERN_PLUGIN_DATA`, else in the Tern state directory. */
export const pluginData = (platform: NodeJS.Platform = process.platform): string =>
  envVar('TERN_PLUGIN_DATA') ?? path.join(ternDir(platform, 'XDG_STATE_HOME', path.join('.local', 'state')), 'plugin-data', PLUGIN_ID);

/** Expands a leading `~` to the home directory. */
export const expandHome = (target: string): string => {
  if (target === '~') {
    return userHome();
  }
  return target.startsWith('~/') ? path.join(userHome(), target.slice(2)) : target;
};

/** The real path of `target`, also when `target` is not on disk: it resolves the nearest parent on disk, then adds back the missing segments. */
const realpathOfExistingPart = (target: string): string => {
  try {
    return realpathSync.native(target);
  } catch {
    return path.join(realpathOfExistingPart(path.dirname(target)), path.basename(target));
  }
};

/** Tells if `child` is `parent` or in it. It resolves symbolic links first, and it compares full path segments only. */
export const isUnder = (child: string, parent: string): boolean => {
  const realChild = realpathOfExistingPart(path.resolve(child));
  const realParent = realpathOfExistingPart(path.resolve(parent));
  const prefix = realParent.endsWith(path.sep) ? realParent : realParent + path.sep;
  return realChild === realParent || realChild.startsWith(prefix);
};

/** The worktree root, the directory that holds the tern-managed worktrees. `omp` is true when it is the omp worktree root. */
export interface WorktreeRoot {
  dir: string;
  omp: boolean;
}

/** Who owns a worktree: `tern` for a tern-managed worktree, `omp` for an omp-owned one, null for a worktree that is not in the worktree root. */
export type WorktreeOwner = 'tern' | 'omp' | null;

/** What the omp worktree root depends on: the env vars, the platform, the home directory that omp reads from the OS, and a test for a path on disk. */
export interface OmpDirsEnv {
  env: Record<string, string | undefined>;
  exists: (target: string) => boolean;
  home: string;
  platform: NodeJS.Platform;
}

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\..*)?$/iu;

/** `value`, or undefined when it is empty: omp reads an empty env var as unset. */
const nonEmpty = (value: string | undefined): string | undefined => (value === '' ? undefined : value);

/** The omp profile that `value` names, or undefined for the default profile: an empty value, `default`, and a name that omp refuses. */
const ompProfileName = (value: string | undefined): string | undefined => {
  const name = value?.trim() ?? '';
  const valid = OMP_PROFILE_NAME.test(name) && !name.endsWith('.') && !WINDOWS_RESERVED_NAME.test(name);
  return valid && name !== 'default' ? name : undefined;
};

/** An omp worktree root override, without the spaces at its two ends, with a leading `~` expanded, normalized and without a trailing separator. Undefined when empty or relative. */
const ompOverride = (value: string | null | undefined, home: string): string | undefined => {
  const trimmed = value?.trim() ?? '';
  const expanded = /^~(?:$|[/\\])/u.test(trimmed) ? home + trimmed.slice(1) : trimmed;
  if (!path.isAbsolute(expanded)) {
    return undefined;
  }
  const dir = path.normalize(expanded);
  return dir.length > 1 && dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
};

/**
 * The omp data root. It is the omp config root, `~/<PI_CONFIG_DIR or .omp>`, plus `profiles/<profile>` for a named profile.
 * On Linux and macOS, when the agent directory is the default one and `$XDG_DATA_HOME/omp` (or `$XDG_DATA_HOME/omp/profiles/<profile>`)
 * is on disk, it is that directory.
 */
const ompDataRoot = ({ env, exists, home, platform }: OmpDirsEnv): string => {
  const profile = ompProfileName(env.OMP_PROFILE ?? env.PI_PROFILE);
  const baseRoot = path.join(home, nonEmpty(env.PI_CONFIG_DIR) ?? '.omp');
  const configRoot = profile === undefined ? baseRoot : path.join(baseRoot, 'profiles', profile);
  const agentEnv = nonEmpty(env.PI_CODING_AGENT_DIR);
  const piProfile = ompProfileName(env.PI_PROFILE);
  const profileDerived = piProfile !== undefined && agentEnv === path.join(baseRoot, 'profiles', piProfile, 'agent');
  const agentOverride = profile === undefined && !profileDerived ? agentEnv : undefined;
  const defaultAgent = agentOverride === undefined || path.resolve(agentOverride) === path.join(configRoot, 'agent');
  const xdgData = nonEmpty(env.XDG_DATA_HOME);
  if ((platform === 'linux' || platform === 'darwin') && defaultAgent && xdgData !== undefined) {
    const appRoot = path.join(xdgData, 'omp');
    const xdgRoot = profile === undefined ? appRoot : path.join(appRoot, 'profiles', profile);
    if (exists(xdgRoot)) {
      return xdgRoot;
    }
  }
  return configRoot;
};

/**
 * The omp worktree root, as omp 18.8.6 resolves it: `$OMP_WORKTREE_DIR`, else `base`, the omp setting `worktree.base`, else `<omp data root>/wt`.
 * An override that is empty or relative after `~` expansion does not count.
 */
export const ompRootDir = (base: string | null, from: OmpDirsEnv): string =>
  ompOverride(from.env.OMP_WORKTREE_DIR, from.home) ?? ompOverride(base, from.home) ?? path.join(ompDataRoot(from), 'wt');

/**
 * Resolves the worktree root: `$TERN_WT_HOME/worktrees` when `TERN_WT_HOME` is set, else the omp worktree root when omp is installed,
 * else `~/.tern-wt/worktrees`. It reads the omp settings in `/`, so the config of a project does not change the root.
 * Throws `omp_failed` when omp is installed but `omp config list --json` fails or prints no JSON object, since the root is then unknown.
 */
export const worktreeRoot = async (): Promise<WorktreeRoot> => {
  const ternHome = envVar('TERN_WT_HOME');
  if (ternHome !== undefined) {
    return { dir: path.join(ternHome, 'worktrees'), omp: false };
  }
  const probe = await ompSettings('/');
  if (probe.omp === null) {
    return { dir: path.join(userHome(), '.tern-wt', 'worktrees'), omp: false };
  }
  if (probe.settings === null) {
    throw new CliError('omp_failed', `${probe.warning}; the omp worktree root is unknown`);
  }
  return { dir: ompRootDir(probe.settings.base, { env: process.env, exists: existsSync, home: homedir(), platform: process.platform }), omp: true };
};

/** The directory name of the worktree of a branch: the branch with each `/` made `-`. */
export const slug = (branch: string): string => branch.replaceAll('/', '-');

/** The tern-managed worktree path of `branch` in the repository named `repoName`: `<root>/<repoName>/<slug>`. */
export const worktreePath = (root: WorktreeRoot, repoName: string, branch: string): string => path.join(root.dir, repoName, slug(branch));

/**
 * Who owns the worktree at `dir` of the repository with the main checkout `mainCheckout`. It is tern-managed when `dir` is `<root>/<repo>/<slug>`,
 * exactly two levels below the root, where `<repo>` is the name of the main checkout. Each other path in the omp worktree root is omp-owned.
 */
export const worktreeOwner = (root: WorktreeRoot, mainCheckout: string, dir: string): WorktreeOwner => {
  const realDir = realpathOfExistingPart(path.resolve(dir));
  const repoDir = path.dirname(realDir);
  if (path.dirname(repoDir) === realpathOfExistingPart(path.resolve(root.dir)) && path.basename(repoDir) === path.basename(mainCheckout)) {
    return 'tern';
  }
  return root.omp && isUnder(realDir, root.dir) ? 'omp' : null;
};
