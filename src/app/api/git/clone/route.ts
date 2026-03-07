/**
 * Git Clone API
 * POST: Clone a repository from URL
 */

import { NextRequest, NextResponse } from 'next/server';
import { cloneRepository, addRepository } from '@/lib/git';
import { validateGitUrl, validatePath } from '@/lib/git/security';
import os from 'os';
import path from 'path';
import fs from 'fs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, targetDir, branch, depth, addAsRepo = true } = body;

    if (!url) {
      return NextResponse.json(
        { error: 'Repository URL is required' },
        { status: 400 }
      );
    }

    // Validate URL format and security
    const urlValidation = validateGitUrl(url);
    if (!urlValidation.valid) {
      return NextResponse.json(
        { error: urlValidation.error },
        { status: 400 }
      );
    }

    // Determine target directory
    let cloneTargetDir = targetDir;
    if (!cloneTargetDir) {
      // Use default directory
      const homeDir = os.homedir();
      const defaultDirs = [
        path.join(homeDir, 'Desktop', 'AI_DEV'),
        path.join(homeDir, 'code'),
        path.join(homeDir, 'projects'),
        path.join(homeDir, 'Developer'),
      ];

      // Find first existing directory
      cloneTargetDir = defaultDirs.find(dir => {
        try {
          return fs.existsSync(dir);
        } catch {
          return false;
        }
      }) || homeDir;
    } else {
      // Validate user-provided target directory
      const pathValidation = validatePath(cloneTargetDir);
      if (!pathValidation.valid) {
        return NextResponse.json(
          { error: pathValidation.error },
          { status: 400 }
        );
      }
      cloneTargetDir = pathValidation.normalized;
    }

    // Check if target directory exists
    if (!fs.existsSync(cloneTargetDir)) {
      return NextResponse.json(
        { error: `Target directory does not exist: ${cloneTargetDir}` },
        { status: 400 }
      );
    }

    // Perform clone
    const result = await cloneRepository(url.trim(), cloneTargetDir, {
      branch,
      depth,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Failed to clone repository' },
        { status: 400 }
      );
    }

    // Add to managed repos if requested
    if (addAsRepo && result.path) {
      try {
        const repo = await addRepository(result.path);
        return NextResponse.json({
          success: true,
          path: result.path,
          repo,
        });
      } catch {
        // Clone succeeded but failed to add to DB
        return NextResponse.json({
          success: true,
          path: result.path,
          warning: 'Repository cloned but failed to add to managed repositories',
        });
      }
    }

    return NextResponse.json({
      success: true,
      path: result.path,
    });
  } catch (error) {
    console.error('Failed to clone repository:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to clone repository: ${errorMessage}` },
      { status: 500 }
    );
  }
}
