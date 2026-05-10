import { LOG_PREFIX } from './constants.js';
import { isVerboseLogging } from './settings.js';

export const log = {
  info(...args: unknown[]): void {
    console.log(LOG_PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(LOG_PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(LOG_PREFIX, ...args);
  },
  debug(...args: unknown[]): void {
    if (isVerboseLogging()) {
      console.debug(LOG_PREFIX, ...args);
    }
  },
};
