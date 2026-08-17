'use strict';

const { maskSecrets } = require('./mask');

// Every argument passes through maskSecrets so a stray console.log of an SSH
// credential or stream key cannot leak into Render's log stream.
function write(level, args) {
  const stamp = new Date().toISOString();
  const parts = args.map((a) => {
    if (a instanceof Error) return maskSecrets(a.stack || a.message);
    if (typeof a === 'object') {
      try {
        return maskSecrets(JSON.stringify(a));
      } catch {
        return '[unserializable]';
      }
    }
    return maskSecrets(a);
  });
  const line = `${stamp} [${level}] ${parts.join(' ')}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
