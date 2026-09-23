'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/hooks/useTranslation';

async function send(body: Record<string, unknown>) {
  const response = await fetch('/api/tokendance/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('authorization failed');
  return response.json();
}

export function TokenDanceAuthorize({ presetKey, providerId, onConnected, onPendingChange }: {
  presetKey: string; providerId?: string; onConnected: (providerId: string) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [flow, setFlow] = useState<{ flowId: string; url: string; expiresAt: number; method: 'browser' | 'code' }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const id = useRef<string | undefined>(undefined);
  const onDone = useRef(onConnected);
  onDone.current = onConnected;

  useEffect(() => {
    onPendingChange(!!flow || busy);
    return () => onPendingChange(false);
  }, [flow, busy, onPendingChange]);

  function cancel() {
    generation.current++;
    if (id.current) void send({ action: 'cancel', flowId: id.current }).catch(() => {});
    id.current = undefined;
    setFlow(undefined); setBusy(false); setCode('');
  }

  useEffect(() => () => {
    generation.current++;
    if (id.current) void send({ action: 'cancel', flowId: id.current }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!flow) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= flow.expiresAt) {
        void send({ action: 'cancel', flowId: flow.flowId }).catch(() => {});
        id.current = undefined; setFlow(undefined); setFailed(true); setBusy(false); return;
      }
      try {
        const response = await fetch(`/api/tokendance/auth?flowId=${encodeURIComponent(flow.flowId)}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('status failed');
        const status = await response.json();
        if (controller.signal.aborted) return;
        if (status.status === 'complete' && status.providerId) {
          id.current = undefined; setFlow(undefined); onDone.current(status.providerId); return;
        }
        if (!['pending', 'exchanging'].includes(status.status)) {
          id.current = undefined; setFlow(undefined); setFailed(true); setBusy(false); return;
        }
      } catch { if (controller.signal.aborted) return; }
      timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [flow]);

  async function start(method: 'browser' | 'code') {
    cancel();
    const attempt = generation.current;
    setBusy(true); setFailed(false);
    try {
      const next = await send({ action: 'start', method, presetKey, providerId });
      if (attempt !== generation.current) {
        void send({ action: 'cancel', flowId: next.flowId }).catch(() => {}); return;
      }
      id.current = next.flowId;
      setFlow({ ...next, method });
    } catch { if (attempt === generation.current) setFailed(true); }
    finally { if (attempt === generation.current) setBusy(false); }
  }

  async function complete() {
    if (!flow) return;
    const attempt = generation.current;
    setBusy(true);
    try { await send({ action: 'complete', flowId: flow.flowId, code }); }
    catch { if (attempt === generation.current) setFailed(true); }
    finally { if (attempt === generation.current) { setBusy(false); setCode(''); } }
  }

  return <div className="space-y-3 rounded-md border p-3 mt-4">
    <p className="text-sm font-medium">{zh ? 'TokenDance 授权' : 'TokenDance authorization'}</p>
    <p className="text-xs text-muted-foreground">{zh
      ? '在 TokenDance 确认 Key 的额度和有效期。授权完成后自动保存到此连接，也可在下方手填 API Key。'
      : 'Confirm the key limits and expiry at TokenDance. Authorization saves this connection automatically. You can also enter an API key below.'}</p>
    {!flow ? <div className="flex gap-2 flex-wrap">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void start('browser')}>{zh ? '浏览器授权' : 'Browser authorization'}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void start('code')}>{zh ? '使用授权码' : 'Use authorization code'}</Button>
    </div> : <>
      <a href={flow.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">{zh ? '打开 TokenDance 授权页面' : 'Open TokenDance authorization page'}</a>
      <p className="text-xs text-muted-foreground">{zh ? '等待授权，10 分钟内有效。浏览器无法回到本机时，取消后选择“使用授权码”。' : 'Waiting for authorization (10 minutes). If the browser cannot return to this device, cancel and use authorization-code mode.'}</p>
      {flow.method === 'code' && <div className="flex gap-2">
        <Input aria-label={zh ? '一次性授权码' : 'One-time authorization code'} type="password" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" />
        <Button type="button" size="sm" disabled={busy || !code.trim()} onClick={() => void complete()}>{zh ? '完成授权' : 'Complete'}</Button>
      </div>}
      <Button type="button" size="sm" variant="ghost" onClick={cancel}>{zh ? '取消授权' : 'Cancel authorization'}</Button>
    </>}
    {failed && <p role="alert" className="text-xs text-destructive">{zh
      ? '授权未完成或已过期，请重试、使用授权码或手填 Key。如果网页已创建 Key，请在 TokenDance 检查并删除不再使用的 Key。'
      : 'Authorization failed or expired. Retry, use a code, or enter a key. If a key was already created, review and delete unused keys at TokenDance.'}</p>}
  </div>;
}
