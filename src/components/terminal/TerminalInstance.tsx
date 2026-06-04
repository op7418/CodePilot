"use client";

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { useTerminal } from "@/hooks/useTerminal";

interface TerminalInstanceProps {
  terminal: ReturnType<typeof useTerminal>;
}

/**
 * TerminalInstance — full terminal emulator powered by xterm.js + node-pty.
 *
 * Renders a real xterm Terminal with proper PTY I/O, resize handling,
 * clickable links, and xterm-256color support.
 */
export function TerminalInstance({ terminal }: TerminalInstanceProps) {
  const { isElectron, connected, exited, create, write, resize, setOnData } = terminal;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize xterm Terminal on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1a1a1a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());

    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    return () => {
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Fit on container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  // Create PTY when xterm is ready and electron is available
  useEffect(() => {
    if (isElectron && !connected && !exited && xtermRef.current) {
      const cols = xtermRef.current.cols;
      const rows = xtermRef.current.rows;
      create(cols, rows);
    }
  }, [isElectron, connected, exited, create]);

  // Wire xterm input -> PTY write
  useEffect(() => {
    if (!xtermRef.current) return;
    const disposable = xtermRef.current.onData((data: string) => {
      write(data);
    });
    return () => disposable.dispose();
  }, [write]);

  // Wire PTY output -> xterm write
  useEffect(() => {
    setOnData((data: string) => {
      xtermRef.current?.write(data);
    });
  }, [setOnData]);

  // Send resize events to PTY when terminal is resized
  const handleResize = useCallback(() => {
    if (xtermRef.current && connected) {
      resize(xtermRef.current.cols, xtermRef.current.rows);
    }
  }, [resize, connected]);

  // Trigger resize after fit
  useEffect(() => {
    if (!fitAddonRef.current) return;
    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
      handleResize();
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [handleResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-auto"
    />
  );
}
