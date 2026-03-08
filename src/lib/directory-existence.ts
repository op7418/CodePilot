import fs from 'fs/promises';
import path from 'path';

export async function findMissingDirectories(directories: string[]): Promise<string[]> {
  const uniqueDirectories = [...new Set(directories.filter(Boolean).map((dir) => path.resolve(dir)))];
  const missing: string[] = [];

  await Promise.all(
    uniqueDirectories.map(async (dir) => {
      try {
        await fs.access(dir);
      } catch {
        missing.push(dir);
      }
    })
  );

  return uniqueDirectories.filter((dir) => missing.includes(dir));
}
