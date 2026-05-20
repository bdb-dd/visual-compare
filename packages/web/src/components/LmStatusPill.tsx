import { type JSX } from 'react';
import { type LmStatusDto } from '../api/client.js';
import { useSystemStatus } from '../hooks/useSystemStatus.js';

/**
 * Compact pill showing LM Studio reachability. Reads from the
 * `SystemStatusProvider` context, which polls /api/meta/system-status
 * once across the whole app (no per-component polling). Click-to-refresh
 * still forces a fresh preflight via `forceRefresh`.
 */
export function LmStatusPill(): JSX.Element {
  const snap = useSystemStatus();
  const status: LmStatusDto | null = snap?.data?.lm ?? null;

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
      onClick={() => void snap?.forceRefresh()}
      style={{ cursor: 'pointer', opacity: snap?.loading ? 0.6 : 1 }}
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
