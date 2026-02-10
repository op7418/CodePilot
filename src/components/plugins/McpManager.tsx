"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, ListViewIcon, CodeIcon, Loading02Icon, ReloadIcon } from "@hugeicons/core-free-icons";
import { McpServerList } from "@/components/plugins/McpServerList";
import { McpServerEditor } from "@/components/plugins/McpServerEditor";
import { ConfigEditor } from "@/components/plugins/ConfigEditor";
import type { MCPServer } from "@/types";

function stripServerSource(server: MCPServer): MCPServer {
  const editableServer = { ...server };
  delete editableServer.source;
  return editableServer;
}

export function McpManager() {
  const [servers, setServers] = useState<Record<string, MCPServer>>({});
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | undefined>();
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [tab, setTab] = useState<"list" | "json">("list");
  const [error, setError] = useState<string | null>(null);

  const fetchServers = useCallback(async (forceRefresh?: boolean) => {
    try {
      setLoading(true);
      setError(null);
      const url = forceRefresh ? "/api/plugins/mcp?refresh=true" : "/api/plugins/mcp";
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to fetch MCP servers");
        return;
      }

      if (data.mcpServers) {
        setServers(data.mcpServers);
      } else {
        setServers({});
      }
    } catch (err) {
      console.error("Failed to fetch MCP servers:", err);
      setError("Failed to connect to API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  function handleEdit(name: string, server: MCPServer) {
    setEditingName(name);
    setEditingServer(stripServerSource(server));
    setEditorOpen(true);
  }

  function handleAdd() {
    setEditingName(undefined);
    setEditingServer(undefined);
    setEditorOpen(true);
  }

  async function handleDelete(name: string) {
    try {
      const res = await fetch(`/api/plugins/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to delete MCP server");
        return;
      }

      await fetchServers();
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
      setError("Failed to delete MCP server");
    }
  }

  async function handleSave(name: string, server: MCPServer) {
    setError(null);

    if (editingName) {
      const updated = { ...servers };
      if (editingName !== name) {
        delete updated[editingName];
      }
      updated[name] = server;

      try {
        const res = await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServers: updated }),
        });

        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "Failed to save MCP server");
          return;
        }

        await fetchServers();
      } catch (err) {
        console.error("Failed to save MCP server:", err);
        setError("Failed to save MCP server");
      }
      return;
    }

    try {
      const res = await fetch("/api/plugins/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, server }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to add MCP server");
        return;
      }

      await fetchServers();
    } catch (err) {
      console.error("Failed to add MCP server:", err);
      setError("Failed to add MCP server");
    }
  }

  async function handleJsonSave(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      const res = await fetch("/api/plugins/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServers: parsed }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save MCP config");
        return;
      }

      await fetchServers();
    } catch (err) {
      console.error("Failed to save MCP config:", err);
      setError("Failed to save MCP config");
    }
  }

  const serverCount = Object.keys(servers).length;

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">MCP Servers</h3>
            {serverCount > 0 && (
              <span className="text-sm text-muted-foreground">
                ({serverCount})
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            CLI-discovered servers are read-only. Add/edit applies to settings.json servers only.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => fetchServers(true)}>
            <HugeiconsIcon icon={ReloadIcon} className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" className="gap-1" onClick={handleAdd}>
            <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
            Add Server
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 mb-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "json")}>
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <HugeiconsIcon icon={ListViewIcon} className="h-3.5 w-3.5" />
            Servers
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5">
            <HugeiconsIcon icon={CodeIcon} className="h-3.5 w-3.5" />
            JSON Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              <p className="text-sm">Loading MCP servers...</p>
            </div>
          ) : (
            <McpServerList
              servers={servers}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <ConfigEditor
            value={JSON.stringify(servers, null, 2)}
            onSave={handleJsonSave}
            label="MCP Server Configuration"
          />
        </TabsContent>
      </Tabs>

      <McpServerEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        name={editingName}
        server={editingServer}
        onSave={handleSave}
      />
    </div>
  );
}
