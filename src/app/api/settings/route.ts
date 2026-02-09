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
    // (e.g. mcpServers configured via CLI)
    const existing = readSettingsFile();
    const merged = { ...existing, ...settings };
    writeSettingsFile(merged);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
