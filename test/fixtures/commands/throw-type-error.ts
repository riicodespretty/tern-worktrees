/** Fails with a `TypeError` whose `code` is not from `parseArgs`. */
export const run = (): never => {
  throw Object.assign(new TypeError('odd'), { code: 'ERR_OTHER' });
};
