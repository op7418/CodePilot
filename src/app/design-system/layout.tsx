import type { ReactNode } from "react";

export default function DesignSystemLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-bold">CodePilot Design System</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pattern components and UI primitives reference (dev only)
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}
