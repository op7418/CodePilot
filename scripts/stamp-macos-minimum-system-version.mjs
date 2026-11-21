#!/usr/bin/env node

// electron-builder 26 cannot emit `minimumSystemVersion` into mac update metadata,
// so this runs in the same build job, right after the universal package step and
// before checksums. The value comes from the Info.plist inside the ZIP the
// metadata points at, so the feed can only describe the app it actually ships.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { readAppMinimumFromZip } from './macos-minimum-system-version.mjs';

const releaseDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
const metadataName = process.argv[3] || '';
if (!releaseDir || !['latest-mac.yml', 'preview-mac.yml'].includes(metadataName)) {
  throw new Error('Usage: node scripts/stamp-macos-minimum-system-version.mjs <release-dir> <latest-mac.yml|preview-mac.yml>');
}

const metadataPath = path.join(releaseDir, metadataName);
const raw = fs.readFileSync(metadataPath, 'utf8');
const document = yaml.load(raw);
if (!document || typeof document !== 'object' || !Array.isArray(document.files) || document.files.length !== 1) {
  throw new Error(`${metadataName} must reference exactly one updater ZIP`);
}
const zipName = String(document.files[0]?.url ?? '');
if (!/\.zip$/i.test(zipName) || path.basename(zipName) !== zipName) {
  throw new Error(`${metadataName} must reference a release-asset ZIP basename, found ${zipName}`);
}

const { lsMinimumSystemVersion, darwinMinimum } = readAppMinimumFromZip(path.join(releaseDir, zipName));

if (Object.hasOwn(document, 'minimumSystemVersion')) {
  if (document.minimumSystemVersion !== darwinMinimum) {
    throw new Error(
      `${metadataName} already declares minimumSystemVersion ${JSON.stringify(document.minimumSystemVersion)}, expected ${darwinMinimum}`,
    );
  }
  console.log(`${metadataName} already declares minimumSystemVersion ${darwinMinimum}`);
} else {
  const separator = raw.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(metadataPath, `${raw}${separator}minimumSystemVersion: ${darwinMinimum}\n`);
  const stamped = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
  if (stamped.minimumSystemVersion !== darwinMinimum) {
    throw new Error(`${metadataName} minimumSystemVersion did not round-trip as the string ${darwinMinimum}`);
  }
  console.log(
    `${metadataName}: minimumSystemVersion ${darwinMinimum} (app LSMinimumSystemVersion ${lsMinimumSystemVersion})`,
  );
}
