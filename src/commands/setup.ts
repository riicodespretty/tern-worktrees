import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { userHome } from '../paths.ts';
import { CliError } from '../proc.ts';
import { pluginLink, pluginLinked } from '../tern.ts';

/** What `setup` did to a symbolic link. */
export type LinkAction = 'created' | 'kept' | 'replaced';

/** A symbolic link that `setup` manages, its target and what `setup` did to it. */
export interface SetupLink {
  path: string;
  target: string;
  action: LinkAction;
}

/** The output of `setup`. */
export interface SetupResult {
  plugin: 'linked' | 'already';
  links: SetupLink[];
}

const conflict = (target: string, reason: string): CliError => new CliError('path_conflict', `${target} ${reason}`, { path: target });

const onDisk = <T>(target: string, action: () => T): T => {
  try {
    return action();
  } catch (error) {
    throw conflict(target, `cannot be used: ${String(error)}`);
  }
};

const existingAncestor = (dir: string): string => {
  try {
    lstatSync(dir);
    return dir;
  } catch {
    return existingAncestor(path.dirname(dir));
  }
};

const existingDirAbove = (link: string): string => {
  const ancestor = existingAncestor(path.dirname(link));
  if (!onDisk(ancestor, () => statSync(ancestor)).isDirectory()) {
    throw conflict(ancestor, 'is not a directory');
  }
  return ancestor;
};

const linkAction = (link: string, target: string): LinkAction => {
  const stat = onDisk(link, () => lstatSync(link, { throwIfNoEntry: false }));
  if (!stat) {
    return 'created';
  }
  if (!stat.isSymbolicLink()) {
    throw conflict(link, 'exists and is not a symbolic link');
  }
  return onDisk(link, () => readlinkSync(link)) === target ? 'kept' : 'replaced';
};

const planLink = (link: string, target: string): SetupLink => {
  const ancestor = existingDirAbove(link);
  const action = linkAction(link, target);
  if (action !== 'kept') {
    onDisk(ancestor, () => {
      accessSync(ancestor, constants.W_OK);
    });
  }
  return { action, path: link, target };
};

const applyLink = (link: SetupLink): void => {
  onDisk(link.path, () => {
    if (link.action === 'replaced') {
      unlinkSync(link.path);
    }
    if (link.action !== 'kept') {
      mkdirSync(path.dirname(link.path), { recursive: true });
      symlinkSync(link.target, link.path);
    }
  });
};

const checkPlugin = (pkg: string): SetupResult['plugin'] => {
  const linked = pluginLinked();
  if (linked !== null && linked !== pkg) {
    throw new CliError('path_conflict', `the tern-worktrees plugin comes from ${linked}, not ${pkg}`, { path: linked });
  }
  return linked === pkg ? 'already' : 'linked';
};

/**
 * `setup`: links the plugin into Tern, `~/.local/bin/tern-wt` to the CLI and `~/.omp/agent/skills/tern-worktrees` to the skill.
 * It checks each link, its parent directories and the plugin before it changes anything, so a `path_conflict` keeps the machine as it was. A second run changes nothing.
 */
export const run = async (args: string[]): Promise<SetupResult> => {
  parseArgs({ args, options: {} });
  const pkg = realpathSync(path.join(import.meta.dirname, '..', '..'));
  const home = userHome();
  const links = [
    planLink(path.join(home, '.local', 'bin', 'tern-wt'), path.join(pkg, 'bin', 'tern-wt')),
    planLink(path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees'), path.join(pkg, 'skills', 'tern-worktrees')),
  ];
  const plugin = checkPlugin(pkg);
  for (const link of links) {
    applyLink(link);
  }
  if (plugin === 'linked') {
    await pluginLink(pkg);
  }
  return { links, plugin };
};
