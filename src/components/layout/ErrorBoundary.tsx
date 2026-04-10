"use client";

import React, { useState } from "react";
import { WarningCircle } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/* ── Fallback UI (functional, so it can use hooks) ──────────── */

function ErrorFallback({
  error,
  onReset,
}: {
  error: Error | null;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <WarningCircle size={24} />
        </div>

        <h2 className="text-lg font-semibold text-foreground">
          {t("error.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("error.description")}
        </p>

        {error && (
          <Button
            variant="link"
            size="sm"
            onClick={() => setShowDetails((s) => !s)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showDetails ? t("error.hideDetails") : t("error.showDetails")}
          </Button>
        )}
        {showDetails && error && (
          <pre className="max-h-40 w-full overflow-auto rounded-md border border-border/50 bg-muted/30 p-3 text-left text-xs text-muted-foreground">
            {error.message}
            {error.stack && `\n\n${error.stack}`}
          </pre>
        )}

        <div className="flex gap-2">
          <Button onClick={onReset}>
            {t("error.tryAgain")}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
          >
            {t("error.reloadApp")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Error Boundary (class component, required by React) ────── */

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error);
    console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <ErrorFallback error={this.state.error} onReset={this.handleReset} />
      );
    }
    return this.props.children;
  }
}
