// =============================================================================
// Native auto-updater (electron-updater) — DISABLED
//
// macOS builds are signed with Developer ID but not notarized. Users update by
// downloading the latest DMG from GitHub Releases. The browser-mode update
// check (/api/app/updates) in the frontend notifies users of new versions.
// =============================================================================

import type { BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initAutoUpdater(_win: BrowserWindow) {
  console.log('[updater] Native auto-updater is disabled. Users should download updates from GitHub Releases.');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setUpdaterWindow(_win: BrowserWindow) {
  // no-op while native updater is disabled
}
