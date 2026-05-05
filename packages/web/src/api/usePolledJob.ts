import { useEffect, useState } from 'react';
import { api } from './client.js';
import type { JobRow } from '@visual-compare/api/types';

export function usePolledJob(jobId: string | null, intervalMs = 1000): JobRow | null {
  const [job, setJob] = useState<JobRow | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { job: row } = await api.getJob(jobId);
        if (stopped) return;
        setJob(row);
        if (row.status === 'pending' || row.status === 'running') {
          timer = setTimeout(tick, intervalMs);
        }
      } catch {
        if (!stopped) timer = setTimeout(tick, intervalMs * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, intervalMs]);
  return job;
}
