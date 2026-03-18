"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  SpinnerGap,
  CheckCircle,
  Warning,
  XCircle,
  CaretRight,
  CaretDown,
  ArrowClockwise,
  Stethoscope,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RepairInfo {
  action: string;
  label: string;
  params?: Record<string, unknown>;
}

interface Finding {
  severity: "pass" | "warn" | "error";
  detail: string;
  repair?: RepairInfo;
  /** All applicable repair actions (may be more than one) */
  repairs?: RepairInfo[];
}

interface Probe {
  name: string;
  status: "pass" | "warn" | "error";
  findings: Finding[];
}

interface DiagnosticResult {
  overall: "pass" | "warn" | "error";
  conclusion: string;
  probes: Probe[];
}

/** Map raw API severity values (ok/warn/error) to UI values (pass/warn/error) */
function mapSeverity(s: string): "pass" | "warn" | "error" {
  if (s === "ok") return "pass";
  if (s === "warn" || s === "warning") return "warn";
  if (s === "error") return "error";
  return "pass";
}

/** Transform raw API response to the UI's DiagnosticResult format */
function transformApiResponse(raw: Record<string, unknown>, isZh: boolean): DiagnosticResult {
  const overall = mapSeverity(String((raw as { overallSeverity?: string }).overallSeverity || (raw as { overall?: string }).overall || "ok"));

  const rawProbes = (raw as { probes?: Array<Record<string, unknown>> }).probes || [];
  const PROBE_NAMES: Record<string, { en: string; zh: string }> = {
    cli: { en: "CLI Health", zh: "CLI 健康" },
    auth: { en: "Auth Source", zh: "鉴权来源" },
    provider: { en: "Provider/Model", zh: "服务商/模型" },
    features: { en: "Feature Compatibility", zh: "功能兼容性" },
    network: { en: "Network/Endpoint", zh: "网络/端点" },
    live: { en: "Live Test", zh: "实际连通测试" },
  };

  const probes: Probe[] = rawProbes.map((p) => {
    const findings = ((p.findings as Array<Record<string, unknown>>) || []).map((f) => {
      // Parse all repair actions from the finding
      const rawActions = (f.repairActions as Array<Record<string, unknown>>) || [];
      const repairs: RepairInfo[] = rawActions.map((a) => ({
        action: String(a.id || a.action || ""),
        label: String(a.label || "Fix"),
        params: (a.params as Record<string, unknown>) || undefined,
      }));
      return {
        severity: mapSeverity(String(f.severity || "ok")),
        detail: String(f.message || f.detail || f.title || ""),
        repair: repairs.length > 0 ? repairs[0] : undefined,
        repairs: repairs.length > 0 ? repairs : undefined,
      };
    });
    const probeKey = String(p.probe || p.id || p.name || "");
    const probeName = PROBE_NAMES[probeKey]
      ? (isZh ? PROBE_NAMES[probeKey].zh : PROBE_NAMES[probeKey].en)
      : String(p.name || p.probe || probeKey);
    return {
      name: probeName,
      status: mapSeverity(String(p.severity || p.status || "ok")),
      findings,
    };
  });

  // Build conclusion from probes
  const errorCount = probes.filter((p) => p.status === "error").length;
  const warnCount = probes.filter((p) => p.status === "warn").length;
  let conclusion = "All checks passed.";
  if (errorCount > 0) conclusion = `${errorCount} error(s) found. Check details below.`;
  else if (warnCount > 0) conclusion = `${warnCount} warning(s) found. Check details below.`;

  return { overall, conclusion, probes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG = {
  pass: { icon: CheckCircle, color: "text-green-500", badgeCls: "bg-green-500/10 text-green-600 border-green-500/30" },
  warn: { icon: Warning, color: "text-yellow-500", badgeCls: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30" },
  error: { icon: XCircle, color: "text-red-500", badgeCls: "bg-red-500/10 text-red-600 border-red-500/30" },
} as const;

function StatusBadge({ status }: { status: "pass" | "warn" | "error" }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 uppercase ${cfg.badgeCls}`}>
      {status}
    </Badge>
  );
}

function FindingIcon({ severity }: { severity: "pass" | "warn" | "error" }) {
  const cfg = STATUS_CONFIG[severity];
  const Icon = cfg.icon;
  return <Icon size={14} className={cfg.color} />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProviderDoctorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderDoctorDialog({ open, onOpenChange }: ProviderDoctorDialogProps) {
  const { t } = useTranslation();
  const isZh = t("nav.chats") === "对话";

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedProbes, setExpandedProbes] = useState<Set<number>>(new Set());
  const [repairingActions, setRepairingActions] = useState<Set<string>>(new Set());

  const [liveProbeRunning, setLiveProbeRunning] = useState(false);
  // Monotonic counter to discard stale live probe responses on re-run
  const diagnosticRunRef = useRef(0);

  const fetchDiagnostics = useCallback(async () => {
    const runId = ++diagnosticRunRef.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setExpandedProbes(new Set());
    setLiveProbeRunning(false);
    try {
      // Fast probes first (~1s) — renders immediately
      const res = await fetch("/api/doctor");
      if (!res.ok) throw new Error("Diagnostic request failed");
      if (runId !== diagnosticRunRef.current) return; // stale
      const raw = await res.json();
      const data = transformApiResponse(raw, isZh);
      setResult(data);
      const toExpand = new Set<number>();
      data.probes.forEach((probe, i) => {
        if (probe.status !== "pass" && probe.findings.length > 0) {
          toExpand.add(i);
        }
      });
      setExpandedProbes(toExpand);
      const fastProbeCount = data.probes.length;

      // Live probe runs separately (up to 15s) — appends when done
      setLiveProbeRunning(true);
      fetch("/api/doctor?live=true")
        .then((r) => r.ok ? r.json() : null)
        .then((liveRaw) => {
          // Discard if a newer run started while we were waiting
          if (runId !== diagnosticRunRef.current) return;
          if (!liveRaw) return;
          const liveData = transformApiResponse(liveRaw, isZh);
          // Live probe is the extra probe beyond the fast probes
          const liveProbe = liveData.probes.length > fastProbeCount
            ? liveData.probes[liveData.probes.length - 1]
            : undefined;
          if (liveProbe) {
            setResult((prev) => {
              if (!prev) return prev;
              // Don't append if already has a live probe (guard against double-append)
              if (prev.probes.length > fastProbeCount) return prev;
              const updated = { ...prev, probes: [...prev.probes, liveProbe] };
              if (liveProbe.status === "error") updated.overall = "error";
              else if (liveProbe.status === "warn" && prev.overall === "pass") updated.overall = "warn";
              return updated;
            });
            if (liveProbe.status !== "pass") {
              setExpandedProbes((prev) => new Set([...prev, fastProbeCount]));
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          if (runId === diagnosticRunRef.current) setLiveProbeRunning(false);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [isZh]);

  useEffect(() => {
    if (open) fetchDiagnostics();
  }, [open, fetchDiagnostics]);

  const toggleProbe = (index: number) => {
    setExpandedProbes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleRepair = async (finding: Finding) => {
    if (!finding.repair) return;
    const key = finding.repair.action;
    setRepairingActions((prev) => new Set(prev).add(key));
    try {
      const res = await fetch("/api/doctor/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: finding.repair.action,
          params: finding.repair.params,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errData.error || `Repair failed (${res.status})`);
      }
      // Re-run diagnostics after repair
      await fetchDiagnostics();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Repair action failed');
    } finally {
      setRepairingActions((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleExport = async () => {
    try {
      const res = await fetch("/api/doctor/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `codepilot-doctor-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* best effort */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope size={18} />
            {isZh ? "Provider 诊断" : "Provider Doctor"}
          </DialogTitle>
          <DialogDescription>
            {isZh
              ? "检查 CLI、认证、模型兼容性和网络连接状态"
              : "Check CLI health, auth, model compatibility, and network connectivity"}
          </DialogDescription>
        </DialogHeader>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <SpinnerGap size={16} className="animate-spin" />
            <span className="text-sm">{isZh ? "正在诊断..." : "Running diagnostics..."}</span>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="rounded-md bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-3">
            {/* Overall summary */}
            <div className="rounded-md border border-border/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{isZh ? "总体状态" : "Overall"}</span>
                <StatusBadge status={result.overall} />
              </div>
              <p className="text-xs text-muted-foreground">{result.conclusion}</p>
            </div>

            {/* Probes */}
            <div className="space-y-1">
              {result.probes.map((probe, i) => {
                const expanded = expandedProbes.has(i);
                const hasFindings = probe.findings.length > 0;
                return (
                  <div key={i} className="rounded-md border border-border/30">
                    <Button
                      variant="ghost"
                      className="flex items-center gap-2 w-full px-3 py-2 h-auto text-left hover:bg-accent/50 rounded-md transition-colors justify-start font-normal"
                      onClick={() => hasFindings && toggleProbe(i)}
                    >
                      <span className="text-xs text-muted-foreground w-4 shrink-0">[{i + 1}]</span>
                      {hasFindings ? (
                        expanded ? <CaretDown size={12} className="shrink-0" /> : <CaretRight size={12} className="shrink-0" />
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <span className="text-sm flex-1">{probe.name}</span>
                      <StatusBadge status={probe.status} />
                    </Button>
                    {expanded && hasFindings && (
                      <div className="px-3 pb-2 space-y-1.5 ml-7">
                        {probe.findings.map((finding, fi) => (
                          <div key={fi} className="flex items-start gap-2">
                            <FindingIcon severity={finding.severity} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-muted-foreground">{finding.detail}</p>
                              {finding.repairs && finding.repairs.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {finding.repairs.map((repair, ri) => (
                                    <Button
                                      key={ri}
                                      variant="outline"
                                      size="xs"
                                      className="text-[11px] h-6"
                                      disabled={repairingActions.has(repair.action)}
                                      onClick={() => handleRepair({ ...finding, repair })}
                                    >
                                      {repairingActions.has(repair.action) ? (
                                        <SpinnerGap size={12} className="animate-spin mr-1" />
                                      ) : null}
                                      {isZh ? "修复: " : "Fix: "}
                                      {repair.label}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {liveProbeRunning && (
                <div className="rounded-md border border-border/30 px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <SpinnerGap size={12} className="animate-spin shrink-0" />
                  {isZh ? "正在运行实际连通性测试..." : "Running live connectivity test..."}
                </div>
              )}
            </div>
          </div>
        )}

        {/* GitHub issue guidance — shown after diagnosis completes */}
        {result && !loading && (
          <div className="rounded-md border border-border/30 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            {isZh ? (
              <>
                {result.overall !== "pass"
                  ? "如果上述修复建议未能解决问题，"
                  : "如果您仍然遇到问题，"}
                请先点击「导出日志」，然后前往{" "}
                <a
                  href="https://github.com/op7418/CodePilot/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground hover:no-underline"
                >
                  GitHub Issues
                </a>
                {" "}提交问题报告，并附上导出的日志文件。
                <br />
                📖 查看{" "}
                <a
                  href="https://www.codepilot.sh/zh/docs/providers"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground hover:no-underline"
                >
                  服务商配置指南
                </a>
              </>
            ) : (
              <>
                {result.overall !== "pass"
                  ? "If the suggestions above don't resolve the issue, "
                  : "If you're still experiencing problems, "}
                click &ldquo;Export Logs&rdquo; first, then{" "}
                <a
                  href="https://github.com/op7418/CodePilot/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground hover:no-underline"
                >
                  open a GitHub Issue
                </a>
                {" "}and attach the exported log file.
                <br />
                📖 See the{" "}
                <a
                  href="https://www.codepilot.sh/docs/providers"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground hover:no-underline"
                >
                  Provider Setup Guide
                </a>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={fetchDiagnostics} disabled={loading}>
            <ArrowClockwise size={14} className={loading ? "animate-spin" : ""} />
            {isZh ? "重新检测" : "Re-run"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={loading || !result}>
            {isZh ? "导出日志" : "Export Logs"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {isZh ? "关闭" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
