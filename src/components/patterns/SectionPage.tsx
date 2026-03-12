import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

const maxWidthMap = {
  sm: "max-w-xl",
  md: "max-w-2xl",
  lg: "max-w-3xl",
} as const;

interface SectionPageProps {
  children: ReactNode;
  maxWidth?: "sm" | "md" | "lg";
  className?: string;
}

export function SectionPage({ children, maxWidth = "lg", className }: SectionPageProps) {
  return (
    <div className={cn("mx-auto w-full space-y-6", maxWidthMap[maxWidth], className)}>
      {children}
    </div>
  );
}
