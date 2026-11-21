import fs from 'node:fs';
import zlib from 'node:zlib';

export function infoPlist(lsMinimumSystemVersion: string | null): string {
  const minimum = lsMinimumSystemVersion === null
    ? ''
    : `    <key>LSMinimumSystemVersion</key>\n    <string>${lsMinimumSystemVersion}</string>\n`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>CFBundleExecutable</key>',
    '    <string>CodePilot</string>',
    `${minimum}  </dict>`,
    '</plist>',
    '',
  ].join('\n');
}

/** Writes a deflated ZIP shaped like the electron-builder mac updater ZIP. */
export function writeAppZip(file: string, plist: string): void {
  const entries = [
    { name: 'CodePilot.app/Contents/MacOS/CodePilot', body: Buffer.from('binary') },
    { name: 'CodePilot.app/Contents/Info.plist', body: Buffer.from(plist) },
    { name: 'CodePilot.app/Contents/Frameworks/CodePilot Helper.app/Contents/Info.plist', body: Buffer.from(infoPlist('13.0')) },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = zlib.deflateRawSync(entry.body);
    const crc = zlib.crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}
