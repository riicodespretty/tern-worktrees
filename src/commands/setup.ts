import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
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

const planLink = (link: string, target: string): SetupLink => {
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) {
    return { action: 'created', path: link, target };
  }
  if (!stat.isSymbolicLink()) {
    throw new CliError('path_conflict', `${link} exists and is not a symbolic link`, { path: link });
  }
  return { action: readlinkSync(link) === target ? 'kept' : 'replaced', path: link, target };
};

const applyLink = (link: SetupLink): void => {
  if (link.action === 'replaced') {
    unlinkSync(link.path);
  }
  if (link.action !== 'kept') {
    mkdirSync(path.dirname(link.path), { recursive: true });
    symlinkSync(link.target, link.path);
  }
};

const linkPlugin = async (pkg: string): Promise<SetupResult['plugin']> => {
  const linked = pluginLinked();
  if (linked === pkg) {
    return 'already';
  }
  if (linked !== null) {
    throw new CliError('path_conflict', `the tern-worktrees plugin comes from ${linked}, not ${pkg}`, { path: linked });
  }
  await pluginLink(pkg);
  return 'linked';
};

/**
 * `setup`: links the plugin into Tern, `~/.local/bin/tern-wt` to the CLI and `~/.omp/agent/skills/tern-worktrees` to the skill.
 * It checks each link before it changes anything, so a `path_conflict` keeps the machine as it was. A second run changes nothing.
 */
export const run = async (args: string[]): Promise<SetupResult> => {
  parseArgs({ args, options: {} });
  const pkg = realpathSync(path.join(import.meta.dirname, '..', '..'));
  const home = userHome();
  const links = [
    planLink(path.join(home, '.local', 'bin', 'tern-wt'), path.join(pkg, 'bin', 'tern-wt')),
    planLink(path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees'), path.join(pkg, 'skills', 'tern-worktrees')),
  ];
  const plugin = await linkPlugin(pkg);
  for (const link of links) {
    applyLink(link);
  }
  return { links, plugin };
};
