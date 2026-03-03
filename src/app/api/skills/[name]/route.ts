import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

function getGlobalCommandsDir(): string {
  return path.join(os.homedir(), ".claude", "commands");
}

function getProjectCommandsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "commands");
}

function getProjectSkillsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "skills");
}

function getInstalledSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

type InstalledSource = "agents" | "claude";
type SkillSource = "global" | "project" | "installed";
type SkillMatch = {
  filePath: string;
  source: SkillSource;
  installedSource?: InstalledSource;
};

function computeContentHash(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/**
 * Parse YAML front matter from SKILL.md content.
 * Extracts `name` and `description` fields from the --- delimited block.
 */
function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return {};

  const frontMatter = fmMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      continue;
    }

    if (/^description:\s*\|/.test(line)) {
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) {
          descLines.push(lines[j].trim());
        } else {
          break;
        }
      }
      if (descLines.length > 0) {
        result.description = descLines.filter(Boolean).join(" ");
      }
      continue;
    }

    const descMatch = line.match(/^description:\s+(.+)/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }
  }
  return result;
}

function countInstalledSkills(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(skillMdPath)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function getPreferredInstalledSource(): InstalledSource {
  const agentsCount = countInstalledSkills(getInstalledSkillsDir());
  const claudeCount = countInstalledSkills(getClaudeSkillsDir());
  return agentsCount === claudeCount
    ? "claude"
    : agentsCount > claudeCount
      ? "agents"
      : "claude";
}

type InstalledMatch = {
  filePath: string;
  installedSource: InstalledSource;
  contentHash: string;
};

function findInstalledSkillMatches(
  name: string,
  installedSource?: InstalledSource
): InstalledMatch[] {
  const matches: InstalledMatch[] = [];
  const dirs: Array<{ dir: string; source: InstalledSource }> = [];
  if (!installedSource || installedSource === "agents") {
    dirs.push({ dir: getInstalledSkillsDir(), source: "agents" });
  }
  if (!installedSource || installedSource === "claude") {
    dirs.push({ dir: getClaudeSkillsDir(), source: "claude" });
  }

  for (const { dir, source } of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillMdPath = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const meta = parseSkillFrontMatter(content);
        const skillName = meta.name || entry.name;
        if (skillName !== name) continue;
        matches.push({
          filePath: skillMdPath,
          installedSource: source,
          contentHash: computeContentHash(content),
        });
      }
    } catch {
      // ignore read errors
    }
  }

  return matches;
}

function findSkillFile(
  name: string,
  options?: { installedSource?: InstalledSource; installedOnly?: boolean; cwd?: string }
):
  | SkillMatch
  | { conflict: true; sources: InstalledSource[] }
  | null {
  const installedSource = options?.installedSource;

  if (!options?.installedOnly) {
    // Check project commands → project skills → global commands → installed
    const projectPath = path.join(getProjectCommandsDir(options?.cwd), `${name}.md`);
    if (fs.existsSync(projectPath)) {
      return { filePath: projectPath, source: "project" };
    }

    // Check project-level .claude/skills/{name}/SKILL.md
    const projectSkillPath = path.join(getProjectSkillsDir(options?.cwd), name, "SKILL.md");
    if (fs.existsSync(projectSkillPath)) {
      return { filePath: projectSkillPath, source: "project" };
    }

    // Check project-level skills by front matter name (scan all subdirs)
    const projectSkillsDir = getProjectSkillsDir(options?.cwd);
    if (fs.existsSync(projectSkillsDir)) {
      try {
        const entries = fs.readdirSync(projectSkillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          if (entry.name === name) continue; // already checked above
          const skillMdPath = path.join(projectSkillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;
          const skillContent = fs.readFileSync(skillMdPath, "utf-8");
          const meta = parseSkillFrontMatter(skillContent);
          if (meta.name === name) {
            return { filePath: skillMdPath, source: "project" };
          }
        }
      } catch {
        // ignore read errors
      }
    }

    const globalPath = path.join(getGlobalCommandsDir(), `${name}.md`);
    if (fs.existsSync(globalPath)) {
      return { filePath: globalPath, source: "global" };
    }
  }

  const installedMatches = findInstalledSkillMatches(name, installedSource);
  if (installedMatches.length === 1) {
    const match = installedMatches[0];
    return {
      filePath: match.filePath,
      source: "installed",
      installedSource: match.installedSource,
    };
  }

  if (installedMatches.length > 1) {
    const uniqueHashes = new Set(installedMatches.map((m) => m.contentHash));
    if (uniqueHashes.size === 1) {
      const preferred = getPreferredInstalledSource();
      const preferredMatch =
        installedMatches.find((m) => m.installedSource === preferred) ||
        installedMatches[0];
      return {
        filePath: preferredMatch.filePath,
        source: "installed",
        installedSource: preferredMatch.installedSource,
      };
    }

    return {
      conflict: true,
      sources: Array.from(
        new Set(installedMatches.map((m) => m.installedSource))
      ),
    };
  }

  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    const url = new URL(_request.url);
    const sourceParam = url.searchParams.get("source");
    const cwdParam = url.searchParams.get("cwd") || undefined;
    const installedSource =
      sourceParam === "agents" || sourceParam === "claude"
        ? (sourceParam as InstalledSource)
        : undefined;
    if (sourceParam && !installedSource) {
      return NextResponse.json(
        { error: "Invalid source; expected 'agents' or 'claude'" },
        { status: 400 }
      );
    }

    const found = installedSource
      ? findSkillFile(name, { installedSource, installedOnly: true, cwd: cwdParam })
      : findSkillFile(name, { cwd: cwdParam });
    if (found && "conflict" in found) {
      return NextResponse.json(
        { error: "Multiple skills with different content", sources: found.sources },
        { status: 409 }
      );
    }
    if (!found) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    const content = fs.readFileSync(found.filePath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim() || "";
    let description: string;

    if (found.filePath.endsWith("SKILL.md")) {
      const meta = parseSkillFrontMatter(content);
      description = meta.description || (firstLine.startsWith("#") ? firstLine.replace(/^#+\s*/, "") : firstLine || `Skill: /${name}`);
    } else {
      description = firstLine.startsWith("#")
        ? firstLine.replace(/^#+\s*/, "")
        : firstLine || `Skill: /${name}`;
    }

    return NextResponse.json({
      skill: {
        name,
        description,
        content,
        source: found.source,
        installedSource: found.installedSource,
        filePath: found.filePath,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read skill" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    const body = await request.json();
    const { content } = body as { content: string };

    const url = new URL(request.url);
    const sourceParam = url.searchParams.get("source");
    const cwdParam = url.searchParams.get("cwd") || undefined;
    const installedSource =
      sourceParam === "agents" || sourceParam === "claude"
        ? (sourceParam as InstalledSource)
        : undefined;
    if (sourceParam && !installedSource) {
      return NextResponse.json(
        { error: "Invalid source; expected 'agents' or 'claude'" },
        { status: 400 }
      );
    }

    const found = installedSource
      ? findSkillFile(name, { installedSource, installedOnly: true, cwd: cwdParam })
      : findSkillFile(name, { cwd: cwdParam });
    if (found && "conflict" in found) {
      return NextResponse.json(
        { error: "Multiple skills with different content", sources: found.sources },
        { status: 409 }
      );
    }
    if (!found) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    fs.writeFileSync(found.filePath, content ?? "", "utf-8");

    const firstLine = (content ?? "").split("\n")[0]?.trim() || "";
    const description = firstLine.startsWith("#")
      ? firstLine.replace(/^#+\s*/, "")
      : firstLine || `Skill: /${name}`;

    return NextResponse.json({
      skill: {
        name,
        description,
        content: content ?? "",
        source: found.source,
        installedSource: found.installedSource,
        filePath: found.filePath,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update skill" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    const url = new URL(_request.url);
    const sourceParam = url.searchParams.get("source");
    const cwdParam = url.searchParams.get("cwd") || undefined;
    const installedSource =
      sourceParam === "agents" || sourceParam === "claude"
        ? (sourceParam as InstalledSource)
        : undefined;
    if (sourceParam && !installedSource) {
      return NextResponse.json(
        { error: "Invalid source; expected 'agents' or 'claude'" },
        { status: 400 }
      );
    }

    const found = installedSource
      ? findSkillFile(name, { installedSource, installedOnly: true, cwd: cwdParam })
      : findSkillFile(name, { cwd: cwdParam });
    if (found && "conflict" in found) {
      return NextResponse.json(
        { error: "Multiple skills with different content", sources: found.sources },
        { status: 409 }
      );
    }
    if (!found) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    fs.unlinkSync(found.filePath);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete skill" },
      { status: 500 }
    );
  }
}
