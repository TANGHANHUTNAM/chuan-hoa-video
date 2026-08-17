'use strict';

/**
 * Wraps a value in POSIX single quotes so the remote shell treats it as one
 * literal argument (spec sections 25, 40.11-40.12).
 *
 * Inside single quotes the shell interprets nothing at all, so the only
 * character needing care is the single quote itself, which we close, escape and
 * reopen: it's  ->  'it'\''s'
 */
function shellEscape(value) {
  const str = String(value);
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a command from a template and arguments, escaping every argument.
 *   sh`df -Pk ${dir}`  ->  df -Pk '/opt/live-manager'
 */
function sh(strings, ...values) {
  return strings.reduce((out, part, i) => {
    if (i === 0) return part;
    return out + shellEscape(values[i - 1]) + part;
  }, '');
}

module.exports = { shellEscape, sh };
