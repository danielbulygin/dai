import pino from 'pino';
import type { Logger } from 'pino';
import { env } from '../env.js';

let _logger: Logger | null = null;

function createLogger(): Logger {
  return pino({
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development' && {
      transport: {
        target: 'pino/file',
        options: { destination: 1 },
      },
    }),
  });
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    if (!_logger) {
      _logger = createLogger();
    }
    const value = (_logger as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return value.bind(_logger);
    }
    return value;
  },
});
