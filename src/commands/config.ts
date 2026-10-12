import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import type { Config } from '../config.ts';

/** `config`: the options file with each default filled in. A bad options file gives `config_invalid`. */
export const run = (args: string[]): Config => {
  parseArgs({ args, options: {} });
  return loadConfig();
};
