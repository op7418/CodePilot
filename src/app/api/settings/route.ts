import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

function readSettingsFile(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const content = fs.readFileSync(SETTINGS_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Return empty object if file doesn't exist or is invalid
  }
  return {};
}

function writeSettingsFile(data: Record<string, unknown>): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function GET() {
  try {
    const settings = readSettingsFile();
    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read settings" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== "object") {
      return NextResponse.json(
        { error: "Invalid settings data" },
        { status: 400 }
      );
    }

    // Merge with existing settings to preserve fields the frontend doesn't manage
    // (e.g. mcpServers configured via CLI).
    // Skip keys whose value is an empty object to avoid accidentally wiping
    // nested configs like mcpServers when the frontend sends {}.
    const existing = readSettingsFile();
    const merged = { ...existing };
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        // Skip empty objects to prevent overwriting nested configs
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) {
          continue;
        }
        merged[key] = value;
      }
    }
    writeSettingsFile(merged);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
