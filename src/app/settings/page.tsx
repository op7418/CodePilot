"use client";

import { Suspense } from "react";
import { SpinnerGap } from "@/components/ui/icon";
import { SettingsLayout } from "@/components/settings/SettingsLayout";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SettingsLayout />
    </Suspense>
  );
}
