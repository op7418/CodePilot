# Lark Webhook Worker

Cloudflare Worker that relays Lark (international) webhook events to your local CodePilot instance via Cloudflare Tunnel.

## Why?

Lark international does not support WebSocket long connections for event subscriptions (only domestic Feishu does). This Worker bridges the gap by:

1. Receiving Lark webhook events at a public HTTPS endpoint
2. Handling URL verification (challenge-response)
3. Forwarding events to your local machine via Cloudflare Tunnel

## Setup

### 1. Install Cloudflare Tunnel

```bash
# macOS
brew install cloudflared

# Or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
```

### 2. Start Tunnel

```bash
# Point tunnel to CodePilot's webhook port (default 9898)
cloudflared tunnel --url localhost:9898
```

Note the tunnel URL (e.g., `https://xxx-xxx-xxx.cfargotunnel.com`).

### 3. Deploy Worker

```bash
cd tools/lark-webhook-worker
npm install
npx wrangler deploy
```

### 4. Set Worker Secrets

```bash
# Set your tunnel URL
npx wrangler secret put TUNNEL_URL
# Paste: https://xxx-xxx-xxx.cfargotunnel.com

# Optional: set verification token for extra security
npx wrangler secret put VERIFICATION_TOKEN
# Paste: your Lark app's Verification Token
```

### 5. Configure Lark

1. Go to [Lark Open Platform](https://open.larksuite.com)
2. Open your app → Event Subscriptions
3. Set Request URL to your Worker URL (e.g., `https://lark-webhook-relay.your-account.workers.dev`)
4. Add event: `im.message.receive_v1`

### 6. Configure CodePilot

1. Open CodePilot → Settings → Remote Bridge → Feishu
2. Set Connection Mode to **Webhook**
3. Enter your App ID, App Secret, and Verification Token
4. Enable the bridge

## Architecture

```
Lark Message → Lark Platform → Worker (CF Edge) → Tunnel → localhost:9898 → CodePilot → Claude
```

## Cost

- Cloudflare Workers: Free tier includes 100,000 requests/day
- Cloudflare Tunnel: Free
- Total: **$0**
