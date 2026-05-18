import { useEffect, useState, type JSX } from 'react';
import { api, type LmStatusDto } from '../api/client.js';

export interface LmStatusPillProps {
  /** Polling interval in ms. 0 disables polling. Default 30s. */
  intervalMs?: number;
}

/**
 * Compact pill showing LM Studio reachability. Polls /api/meta/lm-status
 * (cached server-side for 30s, so a 30s poll is sympathetic).
 */
export function LmStatusPill({ intervalMs = 30_000 }: LmStatusPillProps): JSX.Element {
  const [status, setStatus] = useState<LmStatusDto | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async (force = false) => {
    setLoading(true);
    try {
      const next = await api.getLmStatus(force);
      setStatus(next);
    } catch (err) {
      setStatus({
        ok: false,
        configured: true,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    if (intervalMs <= 0) return;
    const t = setInterval(() => { void refresh(); }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  if (!status) {
    return <span className="status-pill pending">LM …</span>;
  }
  const cls = status.ok ? 'complete' : 'error';
  const label = status.ok
    ? `LM ✓ ${status.configured_model ?? ''}`
    : status.configured
      ? 'LM ✗'
      : 'LM off';
  return (
    <span
      className={`status-pill ${cls}`}
      title={statusTooltip(status)}
      onClick={() => { void refresh(true); }}
      style={{ cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
    >
      {label}
    </span>
  );
}

function statusTooltip(s: LmStatusDto): string {
  if (s.ok) {
    const extras: string[] = [];
    if (s.started_server) extras.push('auto-started server');
    if (s.loaded_model) extras.push('auto-loaded model');
    const tail = extras.length ? ` — ${extras.join('; ')}` : '';
    return `LM Studio is up. Configured model: ${s.configured_model ?? 'unknown'}${tail}. Click to refresh.`;
  }
  return s.message ?? 'LM Studio unavailable. Click to refresh.';
}
