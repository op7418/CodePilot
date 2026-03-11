/**
 * Cloudflare Worker: Lark Webhook → CodePilot relay.
 *
 * Handles:
 * 1. Lark URL verification (challenge-response)
 * 2. Forwards event payloads to CodePilot via Cloudflare Tunnel
 *
 * Environment variables:
 * - TUNNEL_URL: Cloudflare Tunnel URL pointing to CodePilot's local webhook server
 * - VERIFICATION_TOKEN (optional): Lark app's Verification Token for signature check
 */

interface Env {
  TUNNEL_URL: string;
  VERIFICATION_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Validate TUNNEL_URL is configured
    if (!env.TUNNEL_URL) {
      return new Response('TUNNEL_URL not configured', { status: 500 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Handle Lark URL verification challenge
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      // Optionally verify token
      if (env.VERIFICATION_TOKEN && payload.token !== env.VERIFICATION_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return Response.json({ challenge: payload.challenge });
    }

    // Optionally verify event token
    if (env.VERIFICATION_TOKEN) {
      const header = payload.header as { token?: string } | undefined;
      const token = header?.token ?? (payload as { token?: string }).token;
      if (token !== env.VERIFICATION_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // Forward event to CodePilot via Cloudflare Tunnel
    try {
      const tunnelUrl = env.TUNNEL_URL.replace(/\/$/, '');
      const resp = await fetch(tunnelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        console.error(`Tunnel relay failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error('Failed to forward to tunnel:', err);
    }

    // Always return 200 to Lark to acknowledge receipt
    return Response.json({ code: 0, msg: 'ok' });
  },
};
