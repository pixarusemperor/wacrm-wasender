'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * WasenderApi session management — replaces the Meta connect form.
 *
 * The WasenderApi PAT is the SAAS OWNER's token (server-side only).
 * A logged-in user creates their own instance here; the server calls
 * WasenderApi with the owner PAT, stores the per-session key encrypted
 * + scoped to the account, and returns a QR to scan.
 */

interface SessionRow {
  id: string;
  wats_session_id: number | null;
  name: string;
  phone_number: string;
  status: string;
  always_online: boolean;
  proxy_url: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  need_scan: 'Waiting for QR scan',
  need_passkey: 'Passkey required',
  disconnected: 'Disconnected',
  logged_out: 'Logged out',
  expired: 'Expired',
};

export function WasenderSessionsPanel() {
  const t = useTranslations('settings');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [alwaysOnline, setAlwaysOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/wasender/sessions');
      if (!res.ok) throw new Error('Failed to load sessions');
      const json = await res.json();
      setSessions(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/wasender/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone_number: phone, always_online: alwaysOnline }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to create session');
      setName('');
      setPhone('');
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (sessionId: string) => {
    setQrLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/wasender/sessions/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link_method: 'qr' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to connect');
      const data = json.data;
      if (data?.status === 'NEED_SCAN') {
        setQrFor(sessionId);
        setQrCode(data.qrCode);
      } else if (data?.status === 'CONNECTED') {
        setQrFor(null);
        setQrCode(null);
        await loadSessions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    } finally {
      setQrLoading(false);
    }
  };

  const handleAction = async (sessionId: string, action: 'disconnect' | 'restart' | 'delete') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/wasender/sessions/${sessionId}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || `Failed to ${action}`);
      }
      if (action === 'delete') {
        setQrFor(null);
        setQrCode(null);
      }
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="WhatsApp Instances"
        description="Connect WhatsApp numbers via WasenderApi. Sessions are scoped to your account."
      />

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New Instance</CardTitle>
          <CardDescription>
            Create a session, then scan the QR code with your phone to connect.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sess-name">Name</Label>
                <Input
                  id="sess-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Main Sales Line"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sess-phone">Phone number (international)</Label>
                <Input
                  id="sess-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+15550199"
                  required
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={alwaysOnline}
                onChange={(e) => setAlwaysOnline(e.target.checked)}
              />
              Always online
            </label>
            <Button type="submit" disabled={busy || loading}>
              {busy ? 'Creating…' : 'Create Instance'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {qrFor && qrCode && (
        <Card>
          <CardHeader>
            <CardTitle>Scan to connect</CardTitle>
            <CardDescription>
              Open WhatsApp → Linked Devices → Link a device, then scan this code.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <pre className="max-w-full overflow-x-auto rounded border p-4 text-xs">
              {qrCode}
            </pre>
            <Button variant="outline" onClick={() => setQrFor(null)}>
              Done scanning
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Instances</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No instances yet. Create one above.
            </p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div>
                  <p className="font-medium">{s.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {s.phone_number} · {STATUS_LABEL[s.status] ?? s.status}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(s.status === 'need_scan' ||
                    s.status === 'disconnected' ||
                    s.status === 'logged_out' ||
                    s.status === 'expired') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleConnect(s.id)}
                      disabled={qrLoading || busy}
                    >
                      {qrLoading && qrFor === s.id ? 'Loading QR…' : 'Connect'}
                    </Button>
                  )}
                  {s.status === 'connected' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAction(s.id, 'restart')}
                      disabled={busy}
                    >
                      Restart
                    </Button>
                  )}
                  {s.status === 'connected' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAction(s.id, 'disconnect')}
                      disabled={busy}
                    >
                      Disconnect
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleAction(s.id, 'delete')}
                    disabled={busy}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
