/**
 * Git Repository Scan API
 * POST: Scan directories for Git repositories
 */

import { NextRequest, NextResponse } from 'next/server';
import { scanDirectory, addRepository, addScanRoot, getScanRoots } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { roots, addAsScanRoot, useDefault } = body as { roots?: string[]; addAsScanRoot?: boolean; useDefault?: boolean };

    let scanRoots = roots || (await getScanRoots()).map(r => r.path);

    // 如果没有配置扫描根目录且请求默认扫描，使用用户的 Desktop/AI_DEV 目录
    if (scanRoots.length === 0 && useDefault !== false) {
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');
      const homeDir = os.homedir();
      const defaultScanDirs = [
        path.join(homeDir, 'Desktop', 'AI_DEV'),
        path.join(homeDir, 'code'),
        path.join(homeDir, 'projects'),
        path.join(homeDir, 'Developer'),
      ];
      // 只使用存在的目录
      scanRoots = defaultScanDirs.filter(dir => {
        try {
          return fs.existsSync(dir);
        } catch {
          return false;
        }
      });
    }

    if (scanRoots.length === 0) {
      return NextResponse.json(
        { error: 'No scan roots configured. Please specify directories to scan.' },
        { status: 400 }
      );
    }

    const results: {
      found: number;
      added: number;
      skipped: number;
      repos: { path: string; name: string }[];
    } = {
      found: 0,
      added: 0,
      skipped: 0,
      repos: [],
    };

    for (const rootPath of scanRoots) {
      // Add as scan root if requested
      if (addAsScanRoot) {
        await addScanRoot(rootPath);
      }

      // Scan the directory
      const repoPaths = await scanDirectory(rootPath);
      results.found += repoPaths.length;

      // Add each repo
      for (const repoPath of repoPaths) {
        try {
          const repo = await addRepository(repoPath, rootPath);
          results.added++;
          results.repos.push({ path: repo.path, name: repo.name });
        } catch {
          results.skipped++;
        }
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error('Failed to scan repositories:', error);
    return NextResponse.json(
      { error: 'Failed to scan repositories' },
      { status: 500 }
    );
  }
}
