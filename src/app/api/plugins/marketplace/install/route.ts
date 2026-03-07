import { NextResponse } from "next/server";
import { spawn } from "child_process";

import {
  createMarketplacePluginSpawnSpec,
  PluginMarketplaceCliError,
} from "@/lib/plugin-marketplace-cli";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, marketplace, scope } = body as {
      name: string;
      marketplace?: string;
      scope?: "user" | "project" | "local";
    };

    const spec = createMarketplacePluginSpawnSpec({
      action: "install",
      name,
      marketplace,
      scope,
    });

    const child = spawn(spec.command, spec.args, spec.options);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: string) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          send("output", chunk.toString());
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          send("output", chunk.toString());
        });

        child.on("close", (code) => {
          if (code === 0) {
            send("done", "Plugin installed successfully");
          } else {
            send("error", `Process exited with code ${code}`);
          }
          controller.close();
        });

        child.on("error", (err) => {
          send("error", err.message);
          controller.close();
        });
      },
      cancel() {
        child.kill();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[plugins/marketplace/install] Error:", error);
    const status = error instanceof PluginMarketplaceCliError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Install failed" },
      { status }
    );
  }
}
