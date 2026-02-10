'use client';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PencilIcon, ServerStack01Icon, Wifi01Icon, GlobeIcon } from "@hugeicons/core-free-icons";
import type { MCPServer } from '@/types';

interface McpServerListProps {
  servers: Record<string, MCPServer>;
  onEdit: (name: string, server: MCPServer) => void;
  onDelete: (name: string) => void;
}

function getServerTypeInfo(server: MCPServer) {
  const type = server.type || 'stdio';
  switch (type) {
    case 'sse':
      return { label: 'SSE', icon: Wifi01Icon, color: 'text-blue-500' };
    case 'http':
      return { label: 'HTTP', icon: GlobeIcon, color: 'text-green-500' };
    default:
      return { label: 'stdio', icon: ServerStack01Icon, color: 'text-muted-foreground' };
  }
}

export function McpServerList({ servers, onEdit, onDelete }: McpServerListProps) {
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <HugeiconsIcon icon={ServerStack01Icon} className="h-10 w-10 mb-3 opacity-50" />
        <p className="text-sm">No MCP servers configured</p>
        <p className="text-xs mt-1">
          Add an MCP server to extend Claude&apos;s capabilities
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map(([name, server]) => {
        const typeInfo = getServerTypeInfo(server);
        const isCliDiscovered = server.source === 'cli';

        return (
          <Card key={name}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <div className="flex-1 min-w-0 mr-3">
                <div className="flex items-center gap-2 mb-1">
                  <HugeiconsIcon icon={typeInfo.icon} className={`h-4 w-4 shrink-0 ${typeInfo.color}`} />
                  <CardTitle className="text-sm font-medium">{name}</CardTitle>
                  <Badge variant="outline" className="text-xs shrink-0">
                    {typeInfo.label}
                  </Badge>
                  <Badge variant={isCliDiscovered ? 'secondary' : 'default'} className="text-xs shrink-0">
                    {isCliDiscovered ? 'CLI (read-only)' : 'Settings'}
                  </Badge>
                </div>
                <CardDescription className="text-xs mt-1 font-mono">
                  {server.url
                    ? server.url
                    : `${server.command} ${server.args?.join(' ') || ''}`}
                </CardDescription>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEdit(name, server)}
                  disabled={isCliDiscovered}
                  title={isCliDiscovered ? 'CLI-discovered servers are read-only' : 'Edit server'}
                >
                  <HugeiconsIcon icon={PencilIcon} className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => onDelete(name)}
                  disabled={isCliDiscovered}
                  title={isCliDiscovered ? 'CLI-discovered servers are read-only' : 'Delete server'}
                >
                  <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            {(server.env && Object.keys(server.env).length > 0) ||
            (server.args && server.args.length > 0) ? (
              <CardContent className="pt-0">
                {server.args && server.args.length > 0 && (
                  <div className="mb-2">
                    <p className="text-xs text-muted-foreground mb-1">Arguments:</p>
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
                    <p className="text-xs text-muted-foreground mb-1">Environment:</p>
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
