// Where the front desk lives on one machine. Everything is under the person's home, so nothing needs administrator rights.
// FRONTDESK_HOME overrides the home folder (tests use a throwaway one).
import os from 'node:os';
import path from 'node:path';

export function layout(home = process.env.FRONTDESK_HOME || os.homedir()) {
  const base = path.join(home, '.config', 'delegate-skills');
  const fd = path.join(base, 'frontdesk');
  return {
    home,
    base,
    frontdesk: fd,
    bin: path.join(fd, 'bin'),
    generations: path.join(fd, 'generations'),
    current: path.join(fd, 'current.json'),
    state: path.join(fd, 'state'),
    logs: path.join(fd, 'logs'),
    slips: path.join(fd, 'slips'),
    // The receipt is kept outside the front desk folder, like team-install.json, so a damaged folder cannot hide that it was installed.
    receipt: path.join(base, 'frontdesk-install.json'),
    backups: path.join(base, '.backups', 'frontdesk'),
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    codexConfig: path.join(home, '.codex', 'config.toml'),
    museSettings: path.join(home, '.config', 'muse', 'settings.json'),
  };
}

export const READER_SCHEMA = 1; // the ladder release schema this code can read
export const VERSION = '0.1.7';
