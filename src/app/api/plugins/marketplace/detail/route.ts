import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

function getMarketplacesDir(): string {
  return path.join(os.homedir(), ".claude", "plugins", "marketplaces");
}

function findPluginDir(marketplace: string, pluginName: string): string | null {
  const marketplacesDir = getMarketplacesDir();
  if (!fs.existsSync(marketplacesDir)) return null;

  const marketplaces = fs.readdirSync(marketplacesDir, { withFileTypes: true });
  for (const mkt of marketplaces) {
    if (!mkt.isDirectory()) continue;
    const mktDir = path.join(marketplacesDir, mkt.name);

    // Check if this marketplace matches by name or directory name
    let mktName = mkt.name;
    const mktJsonPath = path.join(mktDir, ".claude-plugin", "marketplace.json");
    const mktJsonPath2 = path.join(mktDir, "marketplace.json");
    for (const p of [mktJsonPath, mktJsonPath2]) {
      try {
        if (fs.existsSync(p)) {
          const data = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (data.name) mktName = data.name;
          break;
        }
      } catch { /* ignore */ }
    }

    if (mktName !== marketplace && mkt.name !== marketplace) continue;

    const pluginDir = path.join(mktDir, "plugins", pluginName);
    if (fs.existsSync(pluginDir)) return pluginDir;
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const marketplace = request.nextUrl.searchParams.get("marketplace") || "";
    const pluginName = request.nextUrl.searchParams.get("name") || "";

    if (!marketplace || !pluginName) {
      return NextResponse.json(
        { error: "marketplace and name are required" },
        { status: 400 }
      );
    }

    const pluginDir = findPluginDir(marketplace, pluginName);
    if (!pluginDir) {
      return NextResponse.json(
        { error: "Plugin not found" },
        { status: 404 }
      );
    }

    // Read manifest
    let manifest: Record<string, unknown> = {};
    const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
    try {
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      }
    } catch { /* ignore */ }

    // Read README
    let readme: string | null = null;
    const readmeNames = ["README.md", "readme.md", "Readme.md", "README"];
    for (const name of readmeNames) {
      const readmePath = path.join(pluginDir, name);
      if (fs.existsSync(readmePath)) {
        readme = fs.readFileSync(readmePath, "utf-8");
        break;
      }
    }

    // Detect components with details
    const components: Record<string, string[]> = {};

    // Skills
    const skillsDir = path.join(pluginDir, "skills");
    if (fs.existsSync(skillsDir)) {
      try {
        components.skills = fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch { /* ignore */ }
    }

    // Commands
    const commandsDir = path.join(pluginDir, "commands");
    if (fs.existsSync(commandsDir)) {
      try {
        components.commands = fs
          .readdirSync(commandsDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/, ""));
      } catch { /* ignore */ }
    }

    // Agents
    const agentsDir = path.join(pluginDir, "agents");
    if (fs.existsSync(agentsDir)) {
      try {
        components.agents = fs
          .readdirSync(agentsDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/, ""));
      } catch { /* ignore */ }
    }

    // Hooks
    const hasHooks =
      fs.existsSync(path.join(pluginDir, "hooks")) ||
      fs.existsSync(path.join(pluginDir, "hooks.json"));
    if (hasHooks) {
      components.hooks = ["configured"];
    }

    // MCP
    if (fs.existsSync(path.join(pluginDir, ".mcp.json"))) {
      try {
        const mcpData = JSON.parse(
          fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf-8")
        );
        components.mcp = Object.keys(mcpData.mcpServers || mcpData || {});
      } catch { /* ignore */ }
    }

    // LSP
    if (fs.existsSync(path.join(pluginDir, ".lsp.json"))) {
      try {
        const lspData = JSON.parse(
          fs.readFileSync(path.join(pluginDir, ".lsp.json"), "utf-8")
        );
        components.lsp = Object.keys(lspData);
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      manifest,
      readme,
      components,
    });
  } catch (error) {
    console.error("[plugins/marketplace/detail] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load plugin details" },
      { status: 500 }
    );
  }
}
