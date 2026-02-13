"use client";

import { Suspense } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { SettingsLayout } from "@/components/settings/SettingsLayout";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SettingsLayout />
    </Suspense>
  );
}
