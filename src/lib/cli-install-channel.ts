import path from 'node:path';
import type { CliInstallChannel, CliProvider } from './cli-maintenance-contract';

export interface CliPathClassification {
  channel: CliInstallChannel;
  confidence: 'proven' | 'ambiguous' | 'unknown';
}

/** A Codex binary nested inside another desktop application's installation is
 * owned by that application even when its filename looks like standalone. */
export function isCodexDesktopManagedPath(
  candidatePath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase();
  if (platform === 'darwin') {
    return /(?:^|\/)[^/]+\.app\/contents\//.test(normalized);
  }
  if (platform !== 'win32') return false;
  if (normalized.includes('/program files/windowsapps/')) return true;
  if (normalized.includes('/microsoft/windowsapps/codex')) return true;

  // Future unpackaged/NSIS desktop layouts remain app-owned when the binary
  // sits below a known ChatGPT/Codex application Resources root. Keep the
  // official standalone .../OpenAI/Codex/bin path outside this match.
  return /\/(?:program files(?: \(x86\))?|appdata\/local\/programs)\/(?:openai\/)?(?:chatgpt|codex)(?: desktop)?\/(?:app\/)?resources\//.test(normalized);
}

/** Path evidence is only the first stage; package-manager channels remain
 * ambiguous until their root/cask/package ownership is proven separately. */
export function classifyCliInstallPath(input: {
  provider: CliProvider;
  binaryPath: string;
  realPath: string;
  platform: NodeJS.Platform;
  homeDir: string;
}): CliPathClassification {
  const normalized = input.binaryPath.replace(/\\/g, '/').toLowerCase();
  const real = input.realPath.replace(/\\/g, '/').toLowerCase();
  const home = input.homeDir.replace(/\\/g, '/').toLowerCase();
  const combined = `${normalized}\n${real}`;

  if (input.provider === 'codex') {
    const selectedPaths = [normalized, real];
    const isDesktopBundle = selectedPaths.some((candidate) => (
      isCodexDesktopManagedPath(candidate, input.platform)
    ));
    if (isDesktopBundle) {
      // This binary is lifecycle-owned by the desktop application. Treating
      // its extensionless/.exe shape as standalone would offer a self-update
      // against a signed or package-managed app bundle.
      return { channel: 'desktop_bundle', confidence: 'proven' };
    }
  }

  if (combined.includes('/caskroom/') || combined.includes('/cellar/') || combined.includes('/homebrew/')) {
    return { channel: 'homebrew', confidence: 'ambiguous' };
  }
  if (combined.includes('/.bun/') || combined.includes('/bun/install/')) {
    return { channel: 'bun', confidence: 'ambiguous' };
  }
  if (combined.includes('/pnpm/') || combined.includes('/pnpm-global/')) {
    return { channel: 'pnpm', confidence: 'ambiguous' };
  }
  if (combined.includes('/node_modules/') || combined.includes('/npm-global/') || combined.includes('/appdata/roaming/npm/')) {
    return { channel: 'npm', confidence: 'ambiguous' };
  }

  if (input.provider === 'claude') {
    const nativeRoots = [`${home}/.local/bin/`, `${home}/.claude/bin/`];
    if (nativeRoots.some((root) => normalized.startsWith(root))) {
      // Claude native and WinGet intentionally overlap under ~/.local/bin on
      // Windows. A path alone cannot choose the installer owner.
      return input.platform === 'win32'
        ? { channel: 'unknown', confidence: 'ambiguous' }
        : { channel: 'native', confidence: 'proven' };
    }
  }

  if (input.provider === 'codex') {
    const extension = path.extname(input.binaryPath).toLowerCase();
    const executableShape = input.platform === 'win32'
      ? extension === '.exe'
      : extension === '';
    if (executableShape) return { channel: 'standalone', confidence: 'proven' };
  }

  return { channel: 'unknown', confidence: 'unknown' };
}

export function pathIsInside(candidate: string, parent: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}
