"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Plus, List, Code, SpinnerGap, ArrowsClockwise, WifiHigh } from "@/components/ui/icon";
import { McpServerList } from "@/components/plugins/McpServerList";
import { McpServerEditor } from "@/components/plugins/McpServerEditor";
import { ConfigEditor } from "@/components/plugins/ConfigEditor";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { MCPServer } from "@/types";

interface McpRuntimeStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
}

type MCPServerWithSource = MCPServer & { _source?: string };

export function McpManager() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<Record<string, MCPServerWithSource>>({});
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | undefined>();
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [tab, setTab] = useState<"list" | "json">("list");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<McpRuntimeStatus[]>([]);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

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

  const fetchRuntimeStatus = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      // Try to get active session from stream manager
      const sessionsRes = await fetch('/api/chat/sessions?status=active&limit=1');
      const sessionsData = await sessionsRes.json();
      const sessionId = sessionsData?.sessions?.[0]?.id;

      if (!sessionId) {
        setActiveSessionId(null);
        setRuntimeStatus([]);
        return;
      }

      setActiveSessionId(sessionId);
      const res = await fetch(`/api/plugins/mcp/status?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (data.servers) {
        setRuntimeStatus(data.servers);
      }
    } catch {
      // Runtime status unavailable
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
    fetchRuntimeStatus();
  }, [fetchServers, fetchRuntimeStatus]);

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

  const handlePersistentToggle = useCallback(async (name: string, enabled: boolean) => {
    const updated = { ...servers };
    updated[name] = { ...updated[name], enabled };
    setServers(updated);
    try {
      const res = await fetch('/api/plugins/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: updated }),
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to toggle MCP server:', err);
      // Revert on failure
      fetchServers();
    }
  }, [servers, fetchServers]);

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
      // Rename: preserve _source from the original entry
      const original = servers[editingName];
      const updated = { ...servers };
      delete updated[editingName];
      updated[name] = original?._source ? { ...server, _source: original._source } : server;
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
      // Edit in-place: preserve _source
      const original = servers[editingName];
      const serverWithSource = original?._source ? { ...server, _source: original._source } : server;
      const updated = { ...servers, [name]: serverWithSource };
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
      const parsed = JSON.parse(jsonStr) as Record<string, MCPServer>;
      // JSON editor only manages settings.json servers.
      // Merge back: keep claude.json servers untouched, replace settings.json servers.
      const claudeJsonServers: Record<string, MCPServerWithSource> = {};
      for (const [name, server] of Object.entries(servers)) {
        if (server._source === 'claude.json') {
          claudeJsonServers[name] = server;
        }
      }
      const settingsServers: Record<string, MCPServerWithSource> = {};
      for (const [name, server] of Object.entries(parsed)) {
        settingsServers[name] = { ...server, _source: 'settings.json' };
      }
      const merged = { ...claudeJsonServers, ...settingsServers };
      await fetch("/api/plugins/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServers: merged }),
      });
      setServers(merged);
    } catch (err) {
      console.error("Failed to save MCP config:", err);
    }
  }

  const serverCount = Object.keys(servers).length;

  return (
    <div className="flex h-full flex-col">
      {/* Fixed header */}
      <div className="shrink-0 border-b border-border/50 px-6 pt-4 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">
              {t('extensions.mcpServers')}
              {serverCount > 0 && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  ({serverCount})
                </span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t('mcp.managerDesc' as TranslationKey)}
            </p>
          </div>
          <Button size="sm" className="gap-1" onClick={handleAdd}>
            <Plus size={14} />
            {t('mcp.addServer')}
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-6">

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 mb-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "json")}>
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <List size={14} />
            {t('mcp.listTab')}
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5">
            <Code size={14} />
            {t('mcp.jsonTab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <SpinnerGap size={16} className="animate-spin" />
              <p className="text-sm">{t('mcp.loadingServers')}</p>
            </div>
          ) : (
            <McpServerList
              servers={servers}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleEnabled={handlePersistentToggle}
              runtimeStatus={runtimeStatus}
              activeSessionId={activeSessionId || undefined}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          {Object.values(servers).some(s => s._source === 'claude.json') && (
            <p className="text-xs text-muted-foreground mb-2">
              Servers from ~/.claude.json are managed by Claude CLI and not shown here.
              Use the list tab to edit or delete them.
            </p>
          )}
          <ConfigEditor
            value={JSON.stringify(
              Object.fromEntries(
                Object.entries(servers)
                  .filter(([, v]) => v._source !== 'claude.json')
                  .map(([k, v]) => {
                    const { _source: _unused, ...rest } = v; // eslint-disable-line @typescript-eslint/no-unused-vars
                    return [k, rest];
                  })
              ),
              null,
              2,
            )}
            onSave={handleJsonSave}
            label={t('mcp.serverConfig')}
          />
        </TabsContent>
      </Tabs>

      {/* Runtime Status Section */}
      <div className="mt-6 border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <WifiHigh size={16} className="text-muted-foreground" />
            <h4 className="text-sm font-medium">{t('mcp.runtimeStatus' as TranslationKey)}</h4>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={fetchRuntimeStatus}
            disabled={runtimeLoading}
          >
            {runtimeLoading ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowsClockwise size={12} />}
            {t('mcp.refresh' as TranslationKey)}
          </Button>
        </div>

        {!activeSessionId ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {t('mcp.noActiveSession' as TranslationKey)}
          </p>
        ) : runtimeStatus.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {t('mcp.noRuntimeStatus' as TranslationKey)}
          </p>
        ) : (
          <div className="space-y-1.5">
            {runtimeStatus.map((s) => (
              <div key={s.name} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/30">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    s.status === 'connected' ? 'bg-status-success' :
                    s.status === 'failed' ? 'bg-status-error' :
                    s.status === 'pending' ? 'bg-primary' :
                    s.status === 'disabled' ? 'bg-gray-400' :
                    'bg-status-warning'
                  }`} />
                  <span className="text-xs font-medium truncate">{s.name}</span>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {s.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      <McpServerEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        name={editingName}
        server={editingServer}
        onSave={handleSave}
      />
      </div>
    </div>
  );
}
