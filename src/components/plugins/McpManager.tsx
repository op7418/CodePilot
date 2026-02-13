"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, ListViewIcon, CodeIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { McpServerList } from "@/components/plugins/McpServerList";
import { McpServerEditor } from "@/components/plugins/McpServerEditor";
import { ConfigEditor } from "@/components/plugins/ConfigEditor";
import { useTranslation } from "@/hooks/useTranslation";
import type { MCPServer } from "@/types";

export function McpManager() {
  const [servers, setServers] = useState<Record<string, MCPServer>>({});
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | undefined>();
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [tab, setTab] = useState<"list" | "json">("list");
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const fetchServers = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/plugins/mcp");
      const data = await res.json();
      if (data.mcpServers) {
        setServers(data.mcpServers);
      } else if (data.error) {
        setError(data.error);
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
    setEditingServer(server);
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
      if (res.ok) {
        setServers((prev) => {
          const updated = { ...prev };
          delete updated[name];
          return updated;
        });
      } else {
        const data = await res.json();
        console.error("Failed to delete MCP server:", data.error);
      }
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    }
  }

  async function handleSave(name: string, server: MCPServer) {
    if (editingName && editingName !== name) {
      const updated = { ...servers };
      delete updated[editingName];
      updated[name] = server;
      try {
        await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServers: updated }),
        });
        setServers(updated);
      } catch (err) {
        console.error("Failed to save MCP server:", err);
      }
    } else if (editingName) {
      const updated = { ...servers, [name]: server };
      try {
        await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServers: updated }),
        });
        setServers(updated);
      } catch (err) {
        console.error("Failed to save MCP server:", err);
      }
    } else {
      try {
        const res = await fetch("/api/plugins/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, server }),
        });
        if (res.ok) {
          setServers((prev) => ({ ...prev, [name]: server }));
        } else {
          const data = await res.json();
          console.error("Failed to add MCP server:", data.error);
        }
      } catch (err) {
        console.error("Failed to add MCP server:", err);
      }
    }
  }

  async function handleJsonSave(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      await fetch("/api/plugins/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServers: parsed }),
      });
      setServers(parsed);
    } catch (err) {
      console.error("Failed to save MCP config:", err);
    }
  }

  const serverCount = Object.keys(servers).length;

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{t('mcp.title')}</h3>
            {serverCount > 0 && (
              <span className="text-sm text-muted-foreground">
                ({serverCount})
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('mcp.desc')}
          </p>
        </div>
        <Button size="sm" className="gap-1" onClick={handleAdd}>
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('mcp.addServer')}
        </Button>
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
            {t('mcp.servers')}
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5">
            <HugeiconsIcon icon={CodeIcon} className="h-3.5 w-3.5" />
            {t('mcp.jsonConfig')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              <p className="text-sm">{t('mcp.loading')}</p>
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
            label={t('mcp.configLabel')}
          />
        </TabsContent>
      </Tabs>

      <McpServerEditor
        key={editorOpen ? (editingName || 'new') : 'closed'}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        name={editingName}
        server={editingServer}
        onSave={handleSave}
      />
    </div>
  );
}
