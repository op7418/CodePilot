"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  side: "left" | "right";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

export function ResizeHandle({ side, onResize, onResizeEnd }: ResizeHandleProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = ev.clientX - startX.current;
        startX.current = ev.clientX;
        onResize(delta);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        onResizeEnd?.();
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [onResize, onResizeEnd]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        "group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center",
        side === "left" ? "-ml-0.5" : "-mr-0.5"
      )}
    >
      <div className="h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-border" />
    </div>
  );
}
