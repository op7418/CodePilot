"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { SkillsManager } from "@/components/skills/SkillsManager";
import { McpManager } from "@/components/plugins/McpManager";

type ExtTab = "skills" | "mcp";

export default function ExtensionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ExtensionsPageInner />
    </Suspense>
  );
}

function ExtensionsPageInner() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get("tab") as ExtTab) || "skills";
  const [tab, setTab] = useState<ExtTab>(initialTab);

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-4 pb-0">
        <h1 className="text-xl font-semibold mb-3">Extensions</h1>
        <Tabs value={tab} onValueChange={(v) => setTab(v as ExtTab)}>
          <TabsList>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="mcp">MCP Servers</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex-1 overflow-hidden p-6 flex flex-col min-h-0">
        {tab === "skills" && <SkillsManager />}
        {tab === "mcp" && <McpManager />}
      </div>
    </div>
  );
}
