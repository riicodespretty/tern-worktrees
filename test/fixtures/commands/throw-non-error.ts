/* oxlint-disable no-throw-literal */

/** Fails with a value that is not an `Error`. */
export const run = (): never => {
  // oxlint-disable-next-line typescript/only-throw-error
  throw 'plain';
};
