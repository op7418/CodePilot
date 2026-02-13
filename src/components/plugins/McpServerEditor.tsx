'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { HugeiconsIcon } from "@hugeicons/react";
import { ServerStack01Icon, Wifi01Icon, GlobeIcon, CodeIcon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { MCPServer } from '@/types';

type ServerType = 'stdio' | 'sse' | 'http';

interface McpServerEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name?: string;
  server?: MCPServer;
  onSave: (name: string, server: MCPServer) => void;
}

export function McpServerEditor({
  open,
  onOpenChange,
  name: initialName,
  server: initialServer,
  onSave,
}: McpServerEditorProps) {
  const isEditing = !!initialName;
  const [name, setName] = useState(initialName || '');
  const [serverType, setServerType] = useState<ServerType>(
    initialServer?.type || 'stdio'
  );
  const [command, setCommand] = useState(initialServer?.command || '');
  const [args, setArgs] = useState(initialServer?.args?.join('\n') || '');
  const [url, setUrl] = useState(initialServer?.url || '');
  const [headersText, setHeadersText] = useState(
    initialServer?.headers ? JSON.stringify(initialServer.headers, null, 2) : '{}'
  );
  const [envText, setEnvText] = useState(
    initialServer?.env ? JSON.stringify(initialServer.env, null, 2) : '{}'
  );
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(
    initialServer
      ? JSON.stringify(initialServer, null, 2)
      : '{\n  "command": "",\n  "args": []\n}'
  );
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  function handleSave() {
    setError(null);

    if (!name.trim()) {
      setError(t('mcpEditor.nameRequired'));
      return;
    }

    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError(t('mcpEditor.jsonMustBeObject'));
          return;
        }
        onSave(name.trim(), parsed as MCPServer);
        onOpenChange(false);
      } catch {
        setError(t('mcpEditor.invalidJsonConfig'));
      }
      return;
    }

    // Validate based on server type
    if (serverType === 'stdio') {
      if (!command.trim()) {
        setError(t('mcpEditor.commandRequired'));
        return;
      }
    } else {
      if (!url.trim()) {
        setError(t('mcpEditor.urlRequired'));
        return;
      }
    }

    let env: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(envText);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        env = Object.keys(parsed).length > 0 ? parsed : undefined;
      } else {
        setError(t('mcpEditor.envMustBeObject'));
        return;
      }
    } catch {
      setError(t('mcpEditor.invalidEnvJson'));
      return;
    }

    let headers: Record<string, string> | undefined;
    if (serverType !== 'stdio') {
      try {
        const parsed = JSON.parse(headersText);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          headers = Object.keys(parsed).length > 0 ? parsed : undefined;
        } else {
          setError(t('mcpEditor.headersMustBeObject'));
          return;
        }
      } catch {
        setError(t('mcpEditor.invalidHeadersJson'));
        return;
      }
    }

    const serverArgs = args
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean);

    const server: MCPServer = serverType === 'stdio'
      ? {
          command: command.trim(),
          ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
          ...(env ? { env } : {}),
        }
      : {
          command: '',
          type: serverType,
          ...(url ? { url: url.trim() } : {}),
          ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
          ...(env ? { env } : {}),
          ...(headers ? { headers } : {}),
        };

    onSave(name.trim(), server);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('mcpEditor.editTitle', { name: initialName }) : t('mcpEditor.addTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="server-name">{t('mcpEditor.serverName')}</Label>
            <Input
              id="server-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder={t('mcpEditor.serverNamePlaceholder')}
              disabled={isEditing}
            />
          </div>

          <div className="flex items-center gap-2">
            <Label className="shrink-0">{t('mcpEditor.editMode')}</Label>
            <Button
              variant={jsonMode ? 'outline' : 'default'}
              size="sm"
              onClick={() => {
                setJsonMode(false);
                setError(null);
              }}
            >
              {t('mcpEditor.form')}
            </Button>
            <Button
              variant={jsonMode ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => {
                // Build current config as JSON for the editor
                const currentConfig: Record<string, unknown> = {};
                if (serverType !== 'stdio') {
                  currentConfig.type = serverType;
                  if (url) currentConfig.url = url;
                } else {
                  currentConfig.command = command;
                }
                const argsArr = args.split('\n').map(s => s.trim()).filter(Boolean);
                if (argsArr.length > 0) currentConfig.args = argsArr;
                try {
                  const envParsed = JSON.parse(envText);
                  if (Object.keys(envParsed).length > 0) currentConfig.env = envParsed;
                } catch { /* ignore */ }
                try {
                  const headersParsed = JSON.parse(headersText);
                  if (Object.keys(headersParsed).length > 0) currentConfig.headers = headersParsed;
                } catch { /* ignore */ }
                setJsonText(JSON.stringify(currentConfig, null, 2));
                setJsonMode(true);
                setError(null);
              }}
            >
              <HugeiconsIcon icon={CodeIcon} className="h-3.5 w-3.5" />
              JSON
            </Button>
          </div>

          {jsonMode ? (
            <div className="space-y-2">
              <Label>{t('mcpEditor.serverConfig')}</Label>
              <Textarea
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setError(null);
                }}
                className="font-mono text-sm min-h-[250px]"
                placeholder={'{"command": "npx", "args": ["-y", "@server/name"]}'}
              />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>{t('mcpEditor.serverType')}</Label>
                <Tabs
                  value={serverType}
                  onValueChange={(v) => {
                    setServerType(v as ServerType);
                    setError(null);
                  }}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="stdio" className="flex-1 gap-1.5">
                      <HugeiconsIcon icon={ServerStack01Icon} className="h-3.5 w-3.5" />
                      stdio
                    </TabsTrigger>
                    <TabsTrigger value="sse" className="flex-1 gap-1.5">
                      <HugeiconsIcon icon={Wifi01Icon} className="h-3.5 w-3.5" />
                      SSE
                    </TabsTrigger>
                    <TabsTrigger value="http" className="flex-1 gap-1.5">
                      <HugeiconsIcon icon={GlobeIcon} className="h-3.5 w-3.5" />
                      HTTP
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {serverType === 'stdio' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="server-command">{t('mcpEditor.command')}</Label>
                    <Input
                      id="server-command"
                      value={command}
                      onChange={(e) => {
                        setCommand(e.target.value);
                        setError(null);
                      }}
                      placeholder={t('mcpEditor.commandPlaceholder')}
                      className="font-mono text-sm"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="server-args">{t('mcpEditor.arguments')}</Label>
                    <Textarea
                      id="server-args"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder={"--flag\nvalue"}
                      className="font-mono text-sm min-h-[80px]"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="server-url">{t('mcpEditor.url')}</Label>
                    <Input
                      id="server-url"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setError(null);
                      }}
                      placeholder={
                        serverType === 'sse'
                          ? 'http://localhost:3001/sse'
                          : 'http://localhost:3001'
                      }
                      className="font-mono text-sm"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="server-headers">{t('mcpEditor.headers')}</Label>
                    <Textarea
                      id="server-headers"
                      value={headersText}
                      onChange={(e) => {
                        setHeadersText(e.target.value);
                        setError(null);
                      }}
                      placeholder={'{"Authorization": "Bearer ..."}'}
                      className="font-mono text-sm min-h-[80px]"
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="server-env">{t('mcpEditor.envVars')}</Label>
                <Textarea
                  id="server-env"
                  value={envText}
                  onChange={(e) => {
                    setEnvText(e.target.value);
                    setError(null);
                  }}
                  placeholder={'{"API_KEY": "..."}'}
                  className="font-mono text-sm min-h-[80px]"
                />
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('mcpEditor.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {isEditing ? t('mcpEditor.saveChanges') : t('mcpEditor.addServer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
