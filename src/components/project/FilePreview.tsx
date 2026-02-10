"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Copy01Icon, Tick01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import type { FilePreview as FilePreviewType } from "@/types";

interface FilePreviewProps {
  filePath: string;
  onBack: () => void;
  workingDirectory?: string;
}

export function FilePreview({ filePath, onBack, workingDirectory }: FilePreviewProps) {
  const [preview, setPreview] = useState<FilePreviewType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function loadPreview() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ path: filePath });
        if (workingDirectory) params.set('baseDir', workingDirectory);
        const res = await fetch(
          `/api/files/preview?${params.toString()}`
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to load file");
        }
        const data = await res.json();
        setPreview(data.preview);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setLoading(false);
      }
    }

    loadPreview();
  }, [filePath, workingDirectory]);

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Extract filename from path
  const fileName = filePath.split("/").pop() || filePath;

  // Build breadcrumb segments
  const segments = filePath.split("/").filter(Boolean);
  const displaySegments = segments.slice(-3); // show last 3 segments

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <HugeiconsIcon icon={ArrowLeft01Icon} className="h-3.5 w-3.5" />
          <span className="sr-only">Back to file tree</span>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {displaySegments.length < segments.length && ".../"}{displaySegments.join("/")}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={handleCopyPath}>
          {copied ? (
            <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <HugeiconsIcon icon={Copy01Icon} className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">Copy path</span>
        </Button>
      </div>

      {/* File info */}
      {preview && (
        <div className="flex items-center gap-2 pb-2">
          <Badge variant="secondary" className="text-[10px]">
            {preview.language}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {preview.line_count} lines
          </span>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="py-4 text-center">
            <p className="text-xs text-destructive">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="mt-2 text-xs"
            >
              Back to file tree
            </Button>
          </div>
        ) : preview ? (
          <div className="rounded-md border border-border text-xs">
            <SyntaxHighlighter
              language={preview.language}
              style={atomOneDark}
              showLineNumbers
              customStyle={{
                margin: 0,
                padding: "8px",
                borderRadius: "6px",
                fontSize: "11px",
                lineHeight: "1.5",
              }}
              lineNumberStyle={{
                minWidth: "2.5em",
                paddingRight: "8px",
                color: "#636d83",
                userSelect: "none",
              }}
            >
              {preview.content}
            </SyntaxHighlighter>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
