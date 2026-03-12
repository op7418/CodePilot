"use client";

import { Suspense } from "react";
import { SpinnerGap } from "@/components/ui/icon";
import { BridgeLayout } from "@/components/bridge/BridgeLayout";

export default function BridgePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <BridgeLayout />
    </Suspense>
  );
}
