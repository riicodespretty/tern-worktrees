import { CliError } from '../../../src/proc.ts';

/** Fails with a `CliError` that carries an added field. */
export const run = (): never => {
  throw new CliError('path_conflict', 'taken', { path: '/x' });
};
