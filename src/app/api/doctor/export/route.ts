import os from 'os';
import { NextResponse } from 'next/server';
import { getLastDiagnosisResult, runDiagnosis, getLastLiveProbeError } from '@/lib/provider-doctor';
import { getRecentLogs } from '@/lib/runtime-log';
import { resolveProvider } from '@/lib/provider-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Known vendor hostnames that are safe to expose in full */
const KNOWN_VENDOR_HOSTS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.groq.com',
  'openrouter.ai',
]);

/**
 * Sanitize a URL: keep full URL for known vendors, hostname-only for others.
 */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (KNOWN_VENDOR_HOSTS.has(parsed.hostname)) {
      return url;
    }
    return parsed.hostname;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * Sanitize an API key: return existence flag + last 4 chars.
 */
function sanitizeKey(key: string | undefined | null): { exists: boolean; last4: string } {
  if (!key) return { exists: false, last4: '' };
  return { exists: true, last4: key.slice(-4) };
}

/**
 * Replace home directory with ~ in file paths.
 */
function sanitizePath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return '~' + filePath.slice(home.length);
  }
  return filePath;
}

/**
 * Deep-walk an object and apply sanitization rules.
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Detect API key patterns
    if (/^(sk-|anthropic-|key-|Bearer )/i.test(value) && value.length > 12) {
      return sanitizeKey(value);
    }
    // Detect URL patterns
    if (/^https?:\/\//.test(value)) {
      return sanitizeUrl(value);
    }
    // Detect file paths
    if (value.startsWith(os.homedir())) {
      return sanitizePath(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Key-name-based sanitization for known sensitive fields
      const lowerKey = k.toLowerCase();
      if (lowerKey.includes('api_key') || lowerKey.includes('apikey') || lowerKey.includes('token') || lowerKey.includes('secret')) {
        result[k] = sanitizeKey(typeof v === 'string' ? v : undefined);
      } else if (lowerKey.includes('url') || lowerKey === 'base_url' || lowerKey === 'baseurl') {
        result[k] = typeof v === 'string' ? sanitizeUrl(v) : sanitizeValue(v);
      } else if (lowerKey.includes('path') || lowerKey === 'cwd' || lowerKey === 'home') {
        result[k] = typeof v === 'string' ? sanitizePath(v) : sanitizeValue(v);
      } else {
        result[k] = sanitizeValue(v);
      }
    }
    return result;
  }

  return value;
}

export async function GET() {
  try {
    // Use cached diagnosis if available (avoid re-running live probe).
    // Only run fresh diagnosis if Doctor hasn't been opened yet.
    const diagnosis = getLastDiagnosisResult() ?? await runDiagnosis();
    const runtimeLogs = getRecentLogs();

    // Resolve current provider chain (no raw keys thanks to sanitization)
    const providerResolution = resolveProvider();

    // Capture live probe error (if any) for debugging
    const liveProbeError = getLastLiveProbeError();

    // Build the export package
    const exportPackage = {
      diagnosis: sanitizeValue(diagnosis),
      runtimeLogs: sanitizeValue(runtimeLogs),
      providerResolution: sanitizeValue({
        protocol: providerResolution.protocol,
        authStyle: providerResolution.authStyle,
        model: providerResolution.model,
        upstreamModel: providerResolution.upstreamModel,
        modelDisplayName: providerResolution.modelDisplayName,
        hasCredentials: providerResolution.hasCredentials,
        settingSources: providerResolution.settingSources,
        providerId: providerResolution.provider?.id,
        providerName: providerResolution.provider?.name,
        providerType: providerResolution.provider?.provider_type,
      }),
      liveProbeError: liveProbeError ? sanitizeValue({
        category: liveProbeError.category,
        userMessage: liveProbeError.userMessage,
        actionHint: liveProbeError.actionHint,
        retryable: liveProbeError.retryable,
        providerName: liveProbeError.providerName,
        details: liveProbeError.details,
        rawMessage: liveProbeError.rawMessage,
      }) : null,
      exportedAt: new Date().toISOString(),
    };

    return NextResponse.json(exportPackage);
  } catch (error) {
    console.error('[doctor/export] Export failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
