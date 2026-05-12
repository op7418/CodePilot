import os from 'os';
import path from 'path';

interface BuildExpandedShellPathOptions {
  shellPath?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Build an expanded PATH for child processes.
 *
 * Preserve the user's shell PATH first so `#!/usr/bin/env node` scripts keep
 * using the same Node runtime the user would get in their shell. This avoids
 * accidentally downgrading tools like Claude Code to an older system Node.
 */
export function buildExpandedShellPath(options: BuildExpandedShellPathOptions = {}): string {
  const home = options.home || os.homedir();
  const shellPath = options.shellPath || process.env.PATH || '';
  const platform = options.platform || process.platform;
  const sep = path.delimiter;

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const extras = [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'bin'),
    ];
    const allParts = [shellPath, ...extras].join(sep).split(sep).filter(Boolean);
    return [...new Set(allParts)].join(sep);
  }

  const extras = [
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const allParts = [shellPath, ...extras].join(':').split(':').filter(Boolean);
  return [...new Set(allParts)].join(':');
}
