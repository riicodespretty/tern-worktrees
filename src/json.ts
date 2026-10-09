/** Tells if `value` is a string. */
export const isString = (value: unknown): value is string => typeof value === 'string';

/** Tells if `value` is a JSON object: not null and not an array. */
export const isJsonObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
