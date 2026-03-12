'use client';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash, PencilSimple, HardDrives, WifiHigh, Globe, ArrowsClockwise, SpinnerGap } from "@/components/ui/icon";
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { MCPServer } from '@/types';
import { useState, useCallback } from 'react';

interface McpRuntimeStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
}

interface McpServerListProps {
  servers: Record<string, MCPServer>;
  onEdit: (name: string, server: MCPServer) => void;
  onDelete: (name: string) => void;
  runtimeStatus?: McpRuntimeStatus[];
  activeSessionId?: string;
}

function getServerTypeInfo(server: MCPServer) {
  const type = server.type || 'stdio';
  switch (type) {
    case 'sse':
      return { label: 'SSE', icon: WifiHigh, color: 'text-primary' };
    case 'http':
      return { label: 'HTTP', icon: Globe, color: 'text-status-success-foreground' };
    default:
      return { label: 'stdio', icon: HardDrives, color: 'text-muted-foreground' };
  }
}

function getStatusBadge(status: McpRuntimeStatus['status']) {
  switch (status) {
    case 'connected':
      return { label: 'Connected', className: 'bg-status-success-muted text-status-success-foreground border-status-success-border' };
    case 'failed':
      return { label: 'Failed', className: 'bg-status-error-muted text-status-error-foreground border-status-error-border' };
    case 'needs-auth':
      return { label: 'Auth Required', className: 'bg-status-warning-muted text-status-warning-foreground border-status-warning-border' };
    case 'pending':
      return { label: 'Pending', className: 'bg-primary/10 text-primary border-primary/20' };
    case 'disabled':
      return { label: 'Disabled', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' };
    default:
      return { label: status, className: '' };
  }
}

export function McpServerList({ servers, onEdit, onDelete, runtimeStatus, activeSessionId }: McpServerListProps) {
  const { t } = useTranslation();
  const entries = Object.entries(servers);
  const [reconnecting, setReconnecting] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const handleReconnect = useCallback(async (serverName: string) => {
    if (!activeSessionId) return;
    setReconnecting(prev => new Set(prev).add(serverName));
    try {
      await fetch('/api/plugins/mcp/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, serverName }),
      });
    } catch {
      // Best effort
    } finally {
      setReconnecting(prev => {
        const next = new Set(prev);
        next.delete(serverName);
        return next;
      });
    }
  }, [activeSessionId]);

  const handleToggle = useCallback(async (serverName: string, enabled: boolean) => {
    if (!activeSessionId) return;
    setToggling(prev => new Set(prev).add(serverName));
    try {
      await fetch('/api/plugins/mcp/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, serverName, enabled }),
      });
    } catch {
      // Best effort
    } finally {
      setToggling(prev => {
        const next = new Set(prev);
        next.delete(serverName);
        return next;
      });
    }
  }, [activeSessionId]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <HardDrives size={40} className="mb-3 opacity-50" />
        <p className="text-sm">{t('mcp.noServers')}</p>
        <p className="text-xs mt-1">
          {t('mcp.noServersDesc')}
        </p>
      </div>
    );
  }

  // Build a lookup for runtime status by server name
  const statusByName = new Map<string, McpRuntimeStatus>();
  if (runtimeStatus) {
    for (const s of runtimeStatus) {
      statusByName.set(s.name, s);
    }
  }

  return (
    <div className="space-y-3">
      {entries.map(([name, server]) => {
        const typeInfo = getServerTypeInfo(server);
        const runtime = statusByName.get(name);
        const statusBadge = runtime ? getStatusBadge(runtime.status) : null;
        const isReconnecting = reconnecting.has(name);
        const isToggling = toggling.has(name);

        return (
          <Card key={name}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <div className="flex-1 min-w-0 mr-3">
                <div className="flex items-center gap-2 mb-1">
                  <typeInfo.icon size={16} className={`shrink-0 ${typeInfo.color}`} />
                  <CardTitle className="text-sm font-medium">{name}</CardTitle>
                  <Badge variant="outline" className="text-xs shrink-0">
                    {typeInfo.label}
                  </Badge>
                  {statusBadge ? (
                    <Badge variant="outline" className={`text-xs shrink-0 ${statusBadge.className}`}>
                      {statusBadge.label}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {t('provider.configured')}
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs mt-1 font-mono">
                  {server.url
                    ? server.url
                    : `${server.command} ${server.args?.join(' ') || ''}`}
                </CardDescription>
                {runtime?.serverInfo && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {runtime.serverInfo.name} v{runtime.serverInfo.version}
                  </p>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                {/* Reconnect button — only for failed servers */}
                {runtime?.status === 'failed' && activeSessionId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={isReconnecting}
                    onClick={() => handleReconnect(name)}
                    title={t('mcp.reconnect' as TranslationKey)}
                  >
                    {isReconnecting ? (
                      <SpinnerGap size={14} className="animate-spin" />
                    ) : (
                      <ArrowsClockwise size={14} />
                    )}
                  </Button>
                )}
                {/* Enable button — only for disabled servers */}
                {runtime?.status === 'disabled' && activeSessionId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={isToggling}
                    onClick={() => handleToggle(name, true)}
                  >
                    {isToggling ? (
                      <SpinnerGap size={14} className="animate-spin mr-1" />
                    ) : null}
                    {t('mcp.enable' as TranslationKey)}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEdit(name, server)}
                >
                  <PencilSimple size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => onDelete(name)}
                >
                  <Trash size={14} />
                </Button>
              </div>
            </CardHeader>
            {(server.env && Object.keys(server.env).length > 0) ||
            (server.args && server.args.length > 0) ? (
              <CardContent className="pt-0">
                {server.args && server.args.length > 0 && (
                  <div className="mb-2">
                    <p className="text-xs text-muted-foreground mb-1">{t('mcp.arguments')}</p>
                    <div className="flex gap-1 flex-wrap">
                      {server.args.map((arg, i) => (
                        <Badge key={i} variant="outline" className="text-xs font-mono">
                          {arg}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {server.env && Object.keys(server.env).length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t('mcp.environment')}</p>
                    <div className="flex gap-1 flex-wrap">
                      {Object.keys(server.env).map((key) => (
                        <Badge key={key} variant="outline" className="text-xs font-mono">
                          {key}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
