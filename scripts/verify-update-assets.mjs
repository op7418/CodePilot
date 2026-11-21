#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  compareDarwinVersions,
  isStrictDarwinVersion,
  readAppMinimumFromZip,
} from './macos-minimum-system-version.mjs';

const root = process.argv[2] ? path.resolve(process.argv[2]) : '';
const expectedVersion = process.argv[3] || '';
const channel = process.argv[4] || 'stable';
const target = process.argv[5] || 'all';
if (!root || !expectedVersion) {
  throw new Error('Usage: node scripts/verify-update-assets.mjs <artifact-root> <version> [stable|preview] [all|macos|distribution]');
}
if (!['stable', 'preview'].includes(channel)) throw new Error(`Unsupported update channel: ${channel}`);
if (!['all', 'macos', 'distribution'].includes(target)) throw new Error(`Unsupported release target: ${target}`);
if (target === 'distribution' && channel !== 'stable') {
  throw new Error('The distribution target is stable-only; preview remains a macOS-only updater graph');
}

function walk(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

const allFiles = walk(root);
const byBasename = new Map();
for (const file of allFiles) {
  const name = path.basename(file);
  const current = byBasename.get(name) ?? [];
  current.push(file);
  byBasename.set(name, current);
}

function one(name) {
  const matches = byBasename.get(name) ?? [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name}, found ${matches.length}`);
  return matches[0];
}

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function sha256Hex(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function matching(pattern) {
  return [...byBasename.keys()].filter((name) => pattern.test(name)).sort();
}

function requireCount(label, pattern, count) {
  const matches = matching(pattern);
  if (matches.length !== count) throw new Error(`Expected ${count} ${label}, found ${matches.length}`);
  return matches;
}

const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const macLabelPrefix = channel === 'stable' ? '' : 'preview ';
const macDmgNames = requireCount(
  `${macLabelPrefix}macOS DMG assets`,
  new RegExp(`^CodePilot-${escapedVersion}-(?:arm64|x64|universal)\\.dmg$`),
  3,
);
void macDmgNames;
const macZipNames = requireCount(
  `${macLabelPrefix}macOS ZIP assets`,
  new RegExp(`^CodePilot-${escapedVersion}-(?:arm64|x64|universal)\\.zip$`),
  3,
);
for (const zipName of macZipNames) one(`${zipName}.blockmap`);

if ((target === 'all' || target === 'distribution') && channel === 'stable') {
  requireCount('Windows NSIS installer', new RegExp(`^CodePilot\\.Setup\\.${escapedVersion}\\.exe$`), 1);
  for (const extension of ['AppImage', 'deb', 'rpm']) {
    const linuxAssets = requireCount(
      `Linux ${extension} assets`,
      new RegExp(`^CodePilot-${escapedVersion}-.+\\.${extension}$`, 'i'),
      2,
    );
    if (!linuxAssets.some((name) => /(?:arm64|aarch64)/i.test(name))) {
      throw new Error(`Linux ${extension} assets are missing arm64/aarch64`);
    }
  }
} else if (target === 'all') {
  requireCount('preview Windows NSIS installer', new RegExp(`^CodePilot\\.Setup\\.${escapedVersion}\\.exe$`), 1);
}

if (target === 'macos') {
  const forbidden = /^(?:(?:latest|preview)\.yml|(?:latest|preview)-linux(?:-arm64)?\.yml|CodePilot\.Setup\..*\.exe(?:\.blockmap)?|CodePilot-.*\.(?:AppImage|deb|rpm))$/i;
  const unexpected = matching(forbidden);
  if (unexpected.length > 0) {
    throw new Error(`macOS-only release contains non-macOS update assets: ${unexpected.join(', ')}`);
  }
}

if (target === 'distribution') {
  const forbidden = /^(?:latest-linux(?:-arm64)?\.yml|preview(?:-linux(?:-arm64)?)?\.yml)$/i;
  const unexpected = matching(forbidden);
  if (unexpected.length > 0) {
    throw new Error(`Windows-updater/Linux-manual distribution contains Linux or preview updater metadata: ${unexpected.join(', ')}`);
  }
}

const allowedReleasePayloads = [
  new RegExp(`^CodePilot-${escapedVersion}-(?:arm64|x64|universal)\\.(?:dmg|zip)$`),
  new RegExp(`^CodePilot-${escapedVersion}-(?:arm64|x64|universal)\\.zip\\.blockmap$`),
];
if (target === 'all' || target === 'distribution') {
  allowedReleasePayloads.push(
    new RegExp(`^CodePilot\\.Setup\\.${escapedVersion}\\.exe(?:\\.blockmap)?$`),
  );
}
if ((target === 'all' || target === 'distribution') && channel === 'stable') {
  allowedReleasePayloads.push(
    new RegExp(`^CodePilot-${escapedVersion}-(?:x86_64|arm64)\\.AppImage$`, 'i'),
    new RegExp(`^CodePilot-${escapedVersion}-(?:amd64|arm64)\\.deb$`, 'i'),
    new RegExp(`^CodePilot-${escapedVersion}-(?:x86_64|aarch64)\\.rpm$`, 'i'),
  );
}
const releasePayloads = matching(/\.(?:dmg|zip|blockmap|exe|AppImage|deb|rpm)$/i);
const unexpectedReleasePayloads = releasePayloads.filter(
  (name) => !allowedReleasePayloads.some((pattern) => pattern.test(name)),
);
if (unexpectedReleasePayloads.length > 0) {
  throw new Error(`Release graph contains unexpected or wrong-version payloads: ${unexpectedReleasePayloads.join(', ')}`);
}

const metadataNames = target === 'macos'
  ? [channel === 'stable' ? 'latest-mac.yml' : 'preview-mac.yml']
  : target === 'distribution'
    ? ['latest-mac.yml', 'latest.yml']
  : channel === 'stable'
    ? ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']
    : ['preview.yml', 'preview-mac.yml'];
for (const metadataName of metadataNames) {
  const metadataPath = one(metadataName);
  const raw = fs.readFileSync(metadataPath, 'utf8');
  if (/^stagingPercentage\s*:/m.test(raw)) {
    throw new Error(`${metadataName} must not use stagingPercentage`);
  }
  const document = yaml.load(raw);
  if (!document || typeof document !== 'object') throw new Error(`${metadataName} is not YAML mapping`);
  if (String(document.version) !== expectedVersion) {
    throw new Error(`${metadataName} version ${document.version} != ${expectedVersion}`);
  }
  if (!Array.isArray(document.files) || document.files.length < 1) {
    throw new Error(`${metadataName} has no files`);
  }
  for (const item of document.files) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.sha512 !== 'string') {
      throw new Error(`${metadataName} has malformed file entry`);
    }
    const assetName = path.basename(item.url);
    if (item.url !== assetName) {
      throw new Error(`${metadataName} must use a release-asset basename, found ${item.url}`);
    }
    const assetPath = one(assetName);
    if (sha512Base64(assetPath) !== item.sha512) {
      throw new Error(`${metadataName} sha512 mismatch for ${assetName}`);
    }
    if (!Number.isFinite(item.size) || Number(item.size) <= 0) {
      throw new Error(`${metadataName} must declare a positive size for ${assetName}`);
    }
    if (fs.statSync(assetPath).size !== item.size) {
      throw new Error(`${metadataName} size mismatch for ${assetName}`);
    }
    if (/\.(zip|exe)$/i.test(assetName)) {
      // electron-builder emits external sidecar blockmaps for macOS ZIP and full
      // NSIS artifacts. blockMapSize is reserved for embedded blockmaps (for
      // example AppImage/web-package data), so native latest*.yml omits it.
      one(`${assetName}.blockmap`);
    }
    if (/\.AppImage$/i.test(assetName) && !(Number(item.blockMapSize) > 0)) {
      throw new Error(`${metadataName} must describe the embedded AppImage blockmap`);
    }
  }
}

const macMetadataName = channel === 'stable' ? 'latest-mac.yml' : 'preview-mac.yml';
const macMetadata = yaml.load(fs.readFileSync(one(macMetadataName), 'utf8'));
if (!macMetadata.files.every((item) => /\.zip$/i.test(String(item.url)))) {
  throw new Error(`${macMetadataName} must contain ZIP entries only; stapled DMGs are manual assets`);
}
const expectedMacUpdaterName = `CodePilot-${expectedVersion}-universal.zip`;
if (macMetadata.files.length !== 1 || String(macMetadata.files[0]?.url) !== expectedMacUpdaterName) {
  throw new Error(`${macMetadataName} must contain exactly the current-version universal ZIP ${expectedMacUpdaterName}`);
}
const declaredMinimum = macMetadata.minimumSystemVersion;
if (!isStrictDarwinVersion(declaredMinimum)) {
  throw new Error(
    `${macMetadataName} minimumSystemVersion must be a three-part Darwin version string, found ${JSON.stringify(declaredMinimum)}`,
  );
}
const appMinimum = readAppMinimumFromZip(one(expectedMacUpdaterName));
const minimumOrder = compareDarwinVersions(declaredMinimum, appMinimum.darwinMinimum);
if (minimumOrder < 0) {
  throw new Error(
    `${macMetadataName} minimumSystemVersion ${declaredMinimum} is below the app's LSMinimumSystemVersion `
    + `${appMinimum.lsMinimumSystemVersion} (Darwin ${appMinimum.darwinMinimum})`,
  );
}
if (minimumOrder > 0) {
  throw new Error(
    `${macMetadataName} minimumSystemVersion ${declaredMinimum} is above the app's LSMinimumSystemVersion `
    + `${appMinimum.lsMinimumSystemVersion} (Darwin ${appMinimum.darwinMinimum})`,
  );
}
if (target === 'all' || target === 'distribution') {
  const windowsMetadataName = channel === 'stable' ? 'latest.yml' : 'preview.yml';
  const windowsMetadata = yaml.load(fs.readFileSync(one(windowsMetadataName), 'utf8'));
  const expectedWindowsUpdaterName = `CodePilot.Setup.${expectedVersion}.exe`;
  if (windowsMetadata.files.length !== 1 || String(windowsMetadata.files[0]?.url) !== expectedWindowsUpdaterName) {
    throw new Error(`${windowsMetadataName} must target exactly the current-version full NSIS installer ${expectedWindowsUpdaterName}`);
  }
}

const checksumNames = new Set();
for (const checksumFile of allFiles.filter((file) => /^checksums-.*\.sha256$/.test(path.basename(file)))) {
  for (const line of fs.readFileSync(checksumFile, 'utf8').split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const recorded = match[2].replace(/^\*/, '').replace(/^\.\//, '');
    if (!recorded || path.basename(recorded) !== recorded) continue;
    if (!/^[0-9a-f]{64}$/i.test(match[1])) {
      throw new Error(`${path.basename(checksumFile)} has a malformed SHA-256 for ${recorded}`);
    }
    // Metadata post-processing must happen before checksums; a stale hash here
    // means SHA256SUMS.txt would describe a file that is not the one published.
    if (sha256Hex(one(recorded)) !== match[1].toLowerCase()) {
      throw new Error(`${path.basename(checksumFile)} SHA-256 mismatch for ${recorded}`);
    }
    checksumNames.add(recorded);
  }
}
for (const name of metadataNames) {
  if (!checksumNames.has(name)) throw new Error(`${name} missing from platform checksums`);
}
for (const [name] of byBasename) {
  if ((/\.blockmap$/i.test(name) || /\.(dmg|zip|exe|AppImage|deb|rpm)$/i.test(name)) && !checksumNames.has(name)) {
    throw new Error(`${name} missing from platform checksums`);
  }
}

console.log(`Update asset graph OK: channel=${channel} target=${target} version=${expectedVersion} metadata=${metadataNames.length}`);
