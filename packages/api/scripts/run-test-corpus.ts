/**
 * Test-corpus runner.
 *
 * Discovers fixture pairs under `packages/web/public/fixtures/<pair-id>/`,
 * uploads them as a session, runs one capture run, and runs every requested
 * equivalence level against that capture run. Cross-references each comparison
 * with the pair's `expected.json` and writes a markdown report to
 * `tmp/test-corpus-report.md`.
 *
 * Usage:
 *   pnpm --filter @visual-compare/api exec tsx scripts/run-test-corpus.ts
 *   pnpm --filter @visual-compare/api exec tsx scripts/run-test-corpus.ts --viewports desktop,tablet
 *   pnpm --filter @visual-compare/api exec tsx scripts/run-test-corpus.ts --levels pixel-perfect,strict,tolerant
 *
 * Env:
 *   VC_API_BASE        default http://localhost:3001
 *   VC_FIXTURE_BASE    default http://localhost:5173 (Vite dev server)
 *   VC_REPORT_PATH     default <repo-root>/tmp/test-corpus-report.md
 *   VC_POLL_INTERVAL   default 1000 (ms)
 *   VC_POLL_TIMEOUT    default 600000 (ms)
 *
 * Exits non-zero if any "must" expectation (boolean, not null) was violated.
 */

import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const FIXTURES_ROOT = resolve(REPO_ROOT, 'packages', 'web', 'public', 'fixtures');

const ALL_LEVELS = ['pixel-perfect', 'strict', 'tolerant', 'loose', 'semantic'] as const;
type Level = (typeof ALL_LEVELS)[number];

interface ViewportDef {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  orientation: 'portrait' | 'landscape';
}

const VIEWPORTS: Record<string, ViewportDef> = {
  mobile: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, orientation: 'portrait' },
  tablet: { name: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2, orientation: 'portrait' },
  desktop: { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, orientation: 'landscape' },
};

interface ExpectedJson {
  description: string;
  expected: Partial<Record<Level, boolean | null>>;
  capture_options?: { hideSelectors?: string[] };
  equivalence_overrides?: Record<string, unknown>;
  notes?: string;
}

interface Pair {
  id: string;
  expected: ExpectedJson;
}

interface CliArgs {
  viewports: string[];
  levels: Level[];
  apiBase: string;
  fixtureBase: string;
  webBase: string;
  reportPath: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Set of "<pair-id>:<level>" combinations whose mismatches don't fail the run. */
  allowedMismatches: Set<string>;
}

function parseAllowList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pair, level] = entry.split(':');
      if (!pair || !level) {
        throw new Error(`Invalid --allow-mismatch entry '${entry}'. Use 'pair-id:level'.`);
      }
      if (!ALL_LEVELS.includes(level as Level)) {
        throw new Error(
          `Invalid --allow-mismatch level '${level}' in '${entry}'. Valid: ${ALL_LEVELS.join(', ')}`,
        );
      }
      return `${pair}:${level}`;
    });
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let viewports = ['desktop'];
  let levels: Level[] = [...ALL_LEVELS];
  const defaultApiPort = process.env.API_PORT || process.env.PORT || '3001';
  let apiBase = process.env.VC_API_BASE ?? `http://localhost:${defaultApiPort}`;
  let fixtureBase = process.env.VC_FIXTURE_BASE ?? 'http://localhost:5173';
  let webBase = process.env.VC_WEB_BASE ?? 'http://localhost:5173';
  let reportPath = process.env.VC_REPORT_PATH ?? resolve(REPO_ROOT, 'tmp', 'test-corpus-report.md');
  const pollIntervalMs = Number(process.env.VC_POLL_INTERVAL ?? 1000);
  const pollTimeoutMs = Number(process.env.VC_POLL_TIMEOUT ?? 600_000);
  const allowedMismatches = new Set<string>(
    process.env.VC_ALLOW_MISMATCHES ? parseAllowList(process.env.VC_ALLOW_MISMATCHES) : [],
  );

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--viewports':
        viewports = (next ?? '').split(',').map((v) => v.trim()).filter(Boolean);
        i++;
        break;
      case '--levels':
        levels = (next ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => {
            if (!ALL_LEVELS.includes(v as Level)) {
              throw new Error(`Unknown level '${v}'. Valid: ${ALL_LEVELS.join(', ')}`);
            }
            return v as Level;
          });
        i++;
        break;
      case '--api-base':
        apiBase = next!;
        i++;
        break;
      case '--fixture-base':
        fixtureBase = next!;
        i++;
        break;
      case '--web-base':
        webBase = next!;
        i++;
        break;
      case '--report':
        reportPath = resolve(next!);
        i++;
        break;
      case '--allow-mismatch':
        for (const entry of parseAllowList(next ?? '')) {
          allowedMismatches.add(entry);
        }
        i++;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const v of viewports) {
    if (!VIEWPORTS[v]) {
      throw new Error(`Unknown viewport '${v}'. Valid: ${Object.keys(VIEWPORTS).join(', ')}`);
    }
  }

  return {
    viewports,
    levels,
    apiBase,
    fixtureBase,
    webBase,
    reportPath,
    pollIntervalMs,
    pollTimeoutMs,
    allowedMismatches,
  };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: tsx scripts/run-test-corpus.ts [options]

Options:
  --viewports <list>     Comma-separated viewport names (default: desktop)
                         Valid: ${Object.keys(VIEWPORTS).join(', ')}
  --levels <list>        Comma-separated equivalence levels (default: all)
                         Valid: ${ALL_LEVELS.join(', ')}
  --api-base <url>       API base URL (default: http://localhost:3001 or $PORT)
  --fixture-base <url>   Fixture base URL (default: http://localhost:5173)
  --web-base <url>       Web app base URL for report links (default: http://localhost:5173)
  --report <path>        Output markdown report path (default: <repo>/tmp/test-corpus-report.md)
  --allow-mismatch <list>
                         Comma-separated list of '<pair-id>:<level>' combinations whose
                         hard mismatches are reported but do NOT fail the run. Repeatable.
                         Also reads VC_ALLOW_MISMATCHES env var.
                         Example: --allow-mismatch tp-section-removed:semantic
  -h, --help             Show this help
`);
}

async function discoverPairs(): Promise<Pair[]> {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  const pairs: Pair[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const dir = resolve(FIXTURES_ROOT, entry.name);
    const expectedPath = resolve(dir, 'expected.json');
    try {
      await stat(expectedPath);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[corpus] skipping ${entry.name}: no expected.json`);
      continue;
    }
    for (const f of ['a.html', 'b.html']) {
      try {
        await stat(resolve(dir, f));
      } catch {
        throw new Error(`Pair ${entry.name} is missing ${f}`);
      }
    }
    const text = await readFile(expectedPath, 'utf8');
    let parsed: ExpectedJson;
    try {
      parsed = JSON.parse(text) as ExpectedJson;
    } catch (err) {
      throw new Error(`Pair ${entry.name} has invalid expected.json: ${(err as Error).message}`);
    }
    if (parsed.equivalence_overrides) {
      // eslint-disable-next-line no-console
      console.warn(
        `[corpus] ${entry.name}: equivalence_overrides ignored (no per-pair API yet)`,
      );
    }
    pairs.push({ id: entry.name, expected: parsed });
  }
  pairs.sort((a, b) => a.id.localeCompare(b.id));
  return pairs;
}

function buildCsv(pairs: Pair[], fixtureBase: string): string {
  const lines = ['url_a,url_b,label'];
  for (const pair of pairs) {
    const a = `${fixtureBase}/fixtures/${pair.id}/a.html`;
    const b = `${fixtureBase}/fixtures/${pair.id}/b.html`;
    lines.push(`${a},${b},${pair.id}`);
  }
  return lines.join('\n') + '\n';
}

interface CreatedSession {
  session: { id: string; name: string };
  url_pairs: Array<{ id: string; label: string | null; url_a: string; url_b: string }>;
}

async function uploadSession(apiBase: string, csv: string): Promise<CreatedSession> {
  const form = new FormData();
  form.append('csv', new Blob([csv], { type: 'text/csv' }), 'test-corpus.csv');
  form.append('name', `test-corpus ${new Date().toISOString()}`);
  const res = await fetch(`${apiBase}/api/sessions`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`POST /api/sessions failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CreatedSession;
}

interface JobRow {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  progress_current: number;
  progress_total: number;
  error_message: string | null;
}

async function pollJob(
  apiBase: string,
  jobId: string,
  label: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<JobRow> {
  const start = Date.now();
  let lastProgress = -1;
  while (true) {
    const res = await fetch(`${apiBase}/api/jobs/${jobId}`);
    if (!res.ok) {
      throw new Error(`GET /api/jobs/${jobId} failed: ${res.status} ${await res.text()}`);
    }
    const { job } = (await res.json()) as { job: JobRow };
    if (job.progress_current !== lastProgress) {
      lastProgress = job.progress_current;
      // eslint-disable-next-line no-console
      console.log(
        `[${label}] ${job.status} ${job.progress_current}/${job.progress_total}`,
      );
    }
    if (job.status === 'complete') return job;
    if (job.status === 'error') {
      throw new Error(`Job ${jobId} (${label}) errored: ${job.error_message ?? '(no message)'}`);
    }
    if (Date.now() - start > pollTimeoutMs) {
      throw new Error(`Job ${jobId} (${label}) timed out after ${pollTimeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CaptureRunResult {
  capture_run_id: string;
  job_id: string;
  capture_count: number;
}

async function startCaptureRun(
  apiBase: string,
  sessionId: string,
  viewports: ViewportDef[],
  hideSelectors: string[],
): Promise<CaptureRunResult> {
  const body = {
    session_id: sessionId,
    options: {
      viewports,
      ...(hideSelectors.length > 0 ? { hideSelectors } : {}),
    },
  };
  const res = await fetch(`${apiBase}/api/capture-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST /api/capture-runs failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CaptureRunResult;
}

interface ComparisonRunResult {
  comparison_run_id: string;
  job_id: string;
  comparison_count: number;
}

async function startComparisonRun(
  apiBase: string,
  sessionId: string,
  captureRunId: string,
  level: Level,
): Promise<ComparisonRunResult> {
  const res = await fetch(`${apiBase}/api/comparison-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      capture_run_id: captureRunId,
      options: { equivalenceLevel: level },
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/comparison-runs (${level}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ComparisonRunResult;
}

interface ComparisonDto {
  id: string;
  url_pair_id: string;
  viewport_name: string;
  status: string;
  changed_pixel_percentage: number | null;
  ssim: number | null;
  is_equivalent: number | null;
  lm_summary: string | null;
  lm_confidence: number | null;
  error_message: string | null;
}

async function fetchComparisons(
  apiBase: string,
  comparisonRunId: string,
): Promise<ComparisonDto[]> {
  const res = await fetch(`${apiBase}/api/comparison-runs/${comparisonRunId}`);
  if (!res.ok) {
    throw new Error(
      `GET /api/comparison-runs/${comparisonRunId} failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { comparisons: ComparisonDto[] };
  return data.comparisons;
}

interface ResultRow {
  pairId: string;
  comparisonId: string | null;
  viewport: string;
  level: Level;
  actual: boolean | null;
  expected: boolean | null;
  match: 'ok' | 'mismatch' | 'soft';
  /** True if `match === 'mismatch'` AND this (pair, level) is on the allow-list. */
  allowed: boolean;
  changedPct: number | null;
  ssim: number | null;
  lmSummary: string | null;
  errorMessage: string | null;
}

function intToBool(n: number | null): boolean | null {
  if (n === null) return null;
  return n === 1;
}

function classify(actual: boolean | null, expected: boolean | null): 'ok' | 'mismatch' | 'soft' {
  if (expected === null) return 'soft';
  if (actual === null) return 'mismatch';
  return actual === expected ? 'ok' : 'mismatch';
}

function fmtBool(v: boolean | null): string {
  if (v === null) return '—';
  return v ? '✓ pass' : '✗ flag';
}

function fmtNum(n: number | null, digits = 3): string {
  if (n === null || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

function comparisonLink(webBase: string, comparisonId: string | null): string {
  if (!comparisonId) return '—';
  const short = comparisonId.slice(0, 8);
  return `[\`${short}\`](${webBase}/comparisons/${comparisonId})`;
}

function buildReport(args: {
  pairs: Pair[];
  results: ResultRow[];
  viewports: string[];
  levels: Level[];
  startedAt: string;
  finishedAt: string;
  captureRunId: string;
  sessionId: string;
  webBase: string;
}): string {
  const { pairs, results, viewports, levels, startedAt, finishedAt, captureRunId, sessionId, webBase } = args;

  const lines: string[] = [];
  lines.push('# Visual Compare — Test Corpus Report');
  lines.push('');
  lines.push(`- Started: \`${startedAt}\``);
  lines.push(`- Finished: \`${finishedAt}\``);
  lines.push(`- Session: [\`${sessionId}\`](${webBase}/sessions/${sessionId})`);
  lines.push(`- Capture run: \`${captureRunId}\``);
  lines.push(`- Viewports: ${viewports.join(', ')}`);
  lines.push(`- Levels: ${levels.join(', ')}`);
  lines.push(`- Pairs: ${pairs.length}`);
  lines.push('');

  // Per-level summary
  lines.push('## Summary by level');
  lines.push('');
  lines.push('| Level | Pairs | Pass | Flag | Soft (null expectation) | Hard mismatches | Allowed mismatches |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const level of levels) {
    const rows = results.filter((r) => r.level === level);
    const pass = rows.filter((r) => r.actual === true).length;
    const flag = rows.filter((r) => r.actual === false).length;
    const soft = rows.filter((r) => r.match === 'soft').length;
    const hard = rows.filter((r) => r.match === 'mismatch' && !r.allowed).length;
    const allowed = rows.filter((r) => r.match === 'mismatch' && r.allowed).length;
    lines.push(
      `| \`${level}\` | ${rows.length} | ${pass} | ${flag} | ${soft} | ${hard} | ${allowed} |`,
    );
  }
  lines.push('');

  // Per-pair tables, one per viewport
  for (const viewport of viewports) {
    lines.push(`## Per-pair verdict — ${viewport}`);
    lines.push('');
    const header = ['Pair', 'Description', ...levels.map((l) => l)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
    for (const pair of pairs) {
      const cells = [`\`${pair.id}\``, escapeCell(pair.expected.description)];
      for (const level of levels) {
        const row = results.find(
          (r) => r.pairId === pair.id && r.viewport === viewport && r.level === level,
        );
        if (!row) {
          cells.push('—');
          continue;
        }
        const expected = pair.expected.expected[level];
        const expectedStr = expected === undefined ? '—' : fmtBool(expected ?? null);
        const actualStr = fmtBool(row.actual);
        let marker = '';
        if (row.match === 'mismatch') {
          marker = row.allowed ? ' [allowed]' : ' ⚠️';
        } else if (row.match === 'soft') {
          marker = ' ◌';
        }
        cells.push(`${actualStr} (exp ${expectedStr})${marker}`);
      }
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  // Mismatches deep-dive — split hard (block) vs allowed (acknowledged).
  const allMismatches = results.filter((r) => r.match === 'mismatch');
  const hardMismatches = allMismatches.filter((r) => !r.allowed);
  const allowedMismatches = allMismatches.filter((r) => r.allowed);

  lines.push('## Mismatches (hard — fail the run)');
  lines.push('');
  if (hardMismatches.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Pair | Viewport | Level | Comparison | Expected | Actual | Changed % | SSIM | LM summary | Error |');
    lines.push('|---|---|---|---|---|---|---:|---:|---|---|');
    for (const m of hardMismatches) {
      const pair = pairs.find((p) => p.id === m.pairId);
      const expected = pair?.expected.expected[m.level];
      lines.push(
        `| \`${m.pairId}\` | ${m.viewport} | \`${m.level}\` | ${comparisonLink(webBase, m.comparisonId)} | ` +
          `${fmtBool(expected ?? null)} | ${fmtBool(m.actual)} | ${fmtNum(m.changedPct, 2)} | ${fmtNum(m.ssim, 3)} | ` +
          `${escapeCell(m.lmSummary ?? '')} | ${escapeCell(m.errorMessage ?? '')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Allowed mismatches (acknowledged via --allow-mismatch)');
  lines.push('');
  if (allowedMismatches.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Pair | Viewport | Level | Comparison | Expected | Actual | Changed % | SSIM | LM summary | Error |');
    lines.push('|---|---|---|---|---|---|---:|---:|---|---|');
    for (const m of allowedMismatches) {
      const pair = pairs.find((p) => p.id === m.pairId);
      const expected = pair?.expected.expected[m.level];
      lines.push(
        `| \`${m.pairId}\` | ${m.viewport} | \`${m.level}\` | ${comparisonLink(webBase, m.comparisonId)} | ` +
          `${fmtBool(expected ?? null)} | ${fmtBool(m.actual)} | ${fmtNum(m.changedPct, 2)} | ${fmtNum(m.ssim, 3)} | ` +
          `${escapeCell(m.lmSummary ?? '')} | ${escapeCell(m.errorMessage ?? '')} |`,
      );
    }
  }
  lines.push('');

  // Soft (null expectation) details — useful for tuning
  const softs = results.filter((r) => r.match === 'soft');
  lines.push('## Soft (null expectation) detail');
  lines.push('');
  if (softs.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Pair | Viewport | Level | Comparison | Actual | Changed % | SSIM | LM summary |');
    lines.push('|---|---|---|---|---|---:|---:|---|');
    for (const s of softs) {
      lines.push(
        `| \`${s.pairId}\` | ${s.viewport} | \`${s.level}\` | ${comparisonLink(webBase, s.comparisonId)} | ` +
          `${fmtBool(s.actual)} | ${fmtNum(s.changedPct, 2)} | ${fmtNum(s.ssim, 3)} | ${escapeCell(s.lmSummary ?? '')} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startedAt = new Date().toISOString();

  // eslint-disable-next-line no-console
  console.log(`[corpus] api=${args.apiBase} fixtures=${args.fixtureBase}`);
  // eslint-disable-next-line no-console
  console.log(`[corpus] viewports=${args.viewports.join(',')} levels=${args.levels.join(',')}`);

  const pairs = await discoverPairs();
  if (pairs.length === 0) {
    throw new Error(`No pairs found in ${FIXTURES_ROOT}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[corpus] discovered ${pairs.length} pairs`);

  // Validate --allow-mismatch entries early so a typo doesn't silently mute findings.
  const validPairIds = new Set(pairs.map((p) => p.id));
  for (const entry of args.allowedMismatches) {
    const [pair, level] = entry.split(':') as [string, Level];
    if (!validPairIds.has(pair)) {
      throw new Error(
        `--allow-mismatch references unknown pair '${pair}'. Discovered: ${pairs.map((p) => p.id).join(', ')}`,
      );
    }
    if (!args.levels.includes(level)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[corpus] --allow-mismatch ${entry} references level '${level}' that isn't being run; ignored.`,
      );
    }
  }
  if (args.allowedMismatches.size > 0) {
    // eslint-disable-next-line no-console
    console.log(`[corpus] allow-list: ${Array.from(args.allowedMismatches).join(', ')}`);
  }

  // Sanity check: API and fixture base reachable.
  await assertReachable(`${args.apiBase}/api/health`, 'API');
  await assertReachable(
    `${args.fixtureBase}/fixtures/${pairs[0]!.id}/a.html`,
    'fixture server',
  );

  const csv = buildCsv(pairs, args.fixtureBase);
  const session = await uploadSession(args.apiBase, csv);
  const labelToPairId = new Map<string, string>();
  const urlPairToPairId = new Map<string, string>();
  for (const up of session.url_pairs) {
    if (up.label) {
      labelToPairId.set(up.label, up.label);
      urlPairToPairId.set(up.id, up.label);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[corpus] session ${session.session.id} (${session.url_pairs.length} url_pairs)`);

  // Union all hideSelectors from per-pair expected.json. Selectors that don't
  // match any element on a given page are no-ops, so this is safe.
  const hideSelectors = Array.from(
    new Set(
      pairs.flatMap((p) => p.expected.capture_options?.hideSelectors ?? []),
    ),
  );
  if (hideSelectors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[corpus] hideSelectors (union): ${hideSelectors.join(', ')}`);
  }

  const viewportDefs = args.viewports.map((name) => VIEWPORTS[name]!);
  const captureRun = await startCaptureRun(
    args.apiBase,
    session.session.id,
    viewportDefs,
    hideSelectors,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[corpus] capture run ${captureRun.capture_run_id} queued (${captureRun.capture_count} captures)`,
  );
  await pollJob(
    args.apiBase,
    captureRun.job_id,
    'capture',
    args.pollIntervalMs,
    args.pollTimeoutMs,
  );

  const results: ResultRow[] = [];
  for (const level of args.levels) {
    let comparisonRun: ComparisonRunResult;
    try {
      comparisonRun = await startComparisonRun(
        args.apiBase,
        session.session.id,
        captureRun.capture_run_id,
        level,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[corpus] level ${level} could not start: ${(err as Error).message}`);
      // Treat all pairs at this level as errored so the report shows it.
      for (const pair of pairs) {
        for (const viewport of args.viewports) {
          const expected = pair.expected.expected[level] ?? null;
          const match = classify(null, expected);
          results.push({
            pairId: pair.id,
            comparisonId: null,
            viewport,
            level,
            actual: null,
            expected,
            match,
            allowed: match === 'mismatch' && args.allowedMismatches.has(`${pair.id}:${level}`),
            changedPct: null,
            ssim: null,
            lmSummary: null,
            errorMessage: (err as Error).message,
          });
        }
      }
      continue;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[corpus] ${level} run ${comparisonRun.comparison_run_id} queued (${comparisonRun.comparison_count} comparisons)`,
    );
    await pollJob(
      args.apiBase,
      comparisonRun.job_id,
      `compare:${level}`,
      args.pollIntervalMs,
      args.pollTimeoutMs,
    );
    const comparisons = await fetchComparisons(args.apiBase, comparisonRun.comparison_run_id);
    for (const c of comparisons) {
      const pairId = urlPairToPairId.get(c.url_pair_id);
      if (!pairId) continue;
      const pair = pairs.find((p) => p.id === pairId)!;
      const actual = intToBool(c.is_equivalent);
      const expected = pair.expected.expected[level] ?? null;
      const match = classify(actual, expected);
      results.push({
        pairId,
        comparisonId: c.id,
        viewport: c.viewport_name,
        level,
        actual,
        expected,
        match,
        allowed: match === 'mismatch' && args.allowedMismatches.has(`${pairId}:${level}`),
        changedPct: c.changed_pixel_percentage,
        ssim: c.ssim,
        lmSummary: c.lm_summary,
        errorMessage: c.error_message,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const report = buildReport({
    pairs,
    results,
    viewports: args.viewports,
    levels: args.levels,
    startedAt,
    finishedAt,
    captureRunId: captureRun.capture_run_id,
    sessionId: session.session.id,
    webBase: args.webBase,
  });

  await mkdir(dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[corpus] report written to ${args.reportPath}`);

  const hardMismatches = results.filter((r) => r.match === 'mismatch' && !r.allowed);
  const allowedMismatchCount = results.filter((r) => r.match === 'mismatch' && r.allowed).length;
  if (allowedMismatchCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[corpus] ${allowedMismatchCount} allowed mismatch(es) (acknowledged)`);
  }
  if (hardMismatches.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[corpus] ${hardMismatches.length} hard mismatch(es) — exit 1`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('[corpus] all hard expectations satisfied');
}

async function assertReachable(url: string, label: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${label} returned ${res.status}`);
    }
  } catch (err) {
    throw new Error(`${label} not reachable at ${url}: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
