/**
 * Git Init API
 * POST: Initialize a new git repository in a directory
 */

import { NextRequest, NextResponse } from 'next/server';
import { simpleGit } from 'simple-git';
import { addRepository } from '@/lib/git';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { directory, addAsRepo = true, initialBranch } = body;

    if (!directory) {
      return NextResponse.json(
        { error: 'Directory path is required' },
        { status: 400 }
      );
    }

    // Check if directory exists
    if (!fs.existsSync(directory)) {
      return NextResponse.json(
        { error: `Directory does not exist: ${directory}` },
        { status: 400 }
      );
    }

    // Check if already a git repo
    const gitDir = path.join(directory, '.git');
    if (fs.existsSync(gitDir)) {
      return NextResponse.json(
        { error: 'Directory is already a git repository' },
        { status: 400 }
      );
    }

    // Initialize git repo
    const git = simpleGit(directory);
    const initOptions: string[] = [];
    if (initialBranch) {
      initOptions.push('--initial-branch', initialBranch);
    }
    await git.init(initOptions);

    // Create initial .gitignore if not exists
    const gitignorePath = path.join(directory, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      const defaultGitignore = `# Dependencies
node_modules/

# Build output
dist/
build/
.next/
out/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
`;
      fs.writeFileSync(gitignorePath, defaultGitignore);
    }

    // Add to managed repos if requested
    if (addAsRepo) {
      try {
        const repo = await addRepository(directory);
        return NextResponse.json({
          success: true,
          path: directory,
          repo,
        });
      } catch {
        return NextResponse.json({
          success: true,
          path: directory,
          warning: 'Repository initialized but failed to add to managed repositories',
        });
      }
    }

    return NextResponse.json({
      success: true,
      path: directory,
    });
  } catch (error) {
    console.error('Failed to initialize repository:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to initialize repository: ${errorMessage}` },
      { status: 500 }
    );
  }
}
