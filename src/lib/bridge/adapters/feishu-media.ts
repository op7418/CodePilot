type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | undefined
  | null;

function normalizeMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mime = value.split(';', 1)[0]?.trim().toLowerCase();
  return mime || undefined;
}

function getHeaderValue(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;

  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) || undefined;
  }

  const lookup = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lookup) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }

  return undefined;
}

export function sniffImageMimeType(buffer: Uint8Array): string | undefined {
  if (buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a) {
    return 'image/png';
  }

  if (buffer.length >= 6) {
    const signature = Buffer.from(buffer.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'image/gif';
    }
  }

  if (buffer.length >= 12) {
    const riff = Buffer.from(buffer.subarray(0, 4)).toString('ascii');
    const webp = Buffer.from(buffer.subarray(8, 12)).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }

  if (buffer.length >= 2
    && buffer[0] === 0x42
    && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  return undefined;
}

export function resolveFeishuResourceMimeType(
  resourceType: string,
  buffer: Uint8Array,
  headers?: HeaderBag,
): string {
  const headerMime = normalizeMimeType(getHeaderValue(headers, 'content-type'));

  if (resourceType === 'image') {
    return sniffImageMimeType(buffer) || headerMime || 'image/png';
  }

  if (resourceType === 'audio') {
    return headerMime || 'audio/ogg';
  }

  if (resourceType === 'video') {
    return headerMime || 'video/mp4';
  }

  return headerMime || 'application/octet-stream';
}

export function extensionForMimeType(mimeType: string, resourceType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'audio/ogg':
      return 'ogg';
    case 'video/mp4':
      return 'mp4';
    default:
      return resourceType === 'image' ? 'png' : 'bin';
  }
}
