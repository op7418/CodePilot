"use client";

import { GitLayout } from "@/components/git/GitLayout";
import { usePanel } from "@/hooks/usePanel";

export default function GitPage() {
  const { workingDirectory } = usePanel();

  return (
    <main className="h-full">
      <GitLayout currentProjectPath={workingDirectory} />
    </main>
  );
}
