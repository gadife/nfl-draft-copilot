// Thin wrapper around the chrome-devtools MCP CLI daemon.
// Ported from ../helper/amc/check_imax70.py (cd() / run_js() / ensure_amc_page()).
//
// Why a real browser rather than plain HTTP: Yahoo's player pages need an
// authenticated session, and driving the logged-in Chrome profile means cookies
// and origin come for free on same-origin fetch().

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Resolves via PATH by default; set CHROME_DEVTOOLS_BIN to an absolute path
// if the chrome-devtools CLI isn't on PATH in your shell.
const CD = process.env.CHROME_DEVTOOLS_BIN || 'chrome-devtools';

export function cd(args, { timeout = 150_000 } = {}) {
  try {
    return execFileSync(CD, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // The CLI writes useful diagnostics to both streams before a non-zero exit.
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/**
 * Evaluate an async JS function in the selected page and return parsed JSON.
 *
 * The snippet must `return JSON.stringify(x)` (the amc convention). We route the
 * result through --filePath rather than stdout: payloads here run to megabytes,
 * which would otherwise blow past the CLI's inline output limits.
 */
export function runJs(fn, { retries = 2, timeout = 150_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nfldraft-'));
  const out = join(dir, 'out.json');
  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (existsSync(out)) unlinkSync(out);
    last = cd(['evaluate_script', String(fn), '--filePath', out], { timeout });
    if (existsSync(out)) {
      const raw = readFileSync(out, 'utf8');
      const parsed = tryParse(raw);
      if (parsed !== undefined) return parsed;
    }
    // Fallback: some CLI versions still inline the result in a ```json fence.
    const m = last.match(/```json\n([\s\S]*?)\n```/);
    if (m) {
      const parsed = tryParse(m[1]);
      if (parsed !== undefined) return parsed;
    }
    if (attempt < retries) sleep(4000);
  }
  throw new Error(`evaluate_script failed: ${last.slice(-500).trim()}`);
}

// The value arrives double-encoded (JS returned a string, the CLI JSON-encodes it).
function tryParse(raw) {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    try { return JSON.parse(raw.trim()); } catch { return undefined; }
  }
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function listPages() {
  return cd(['list_pages']).split('\n')
    .map(l => l.match(/^(\d+):\s+(.*?)\s+\((https?:\/\/[^)]+)\)(\s*\[selected\])?/))
    .filter(Boolean)
    .map(m => ({ id: +m[1], title: m[2], url: m[3], selected: !!m[4] }));
}

/**
 * Guarantee a live, logged-in Yahoo fantasy tab before trusting any scrape.
 * amc's canary lesson: a stale tab returns plausible-looking garbage, so prove
 * a same-origin authenticated fetch works instead of assuming it does.
 */
export function ensureYahooPage(leagueUrl) {
  const onYahoo = listPages().find(p => p.url.includes('football.fantasysports.yahoo.com'));
  if (!onYahoo) cd(['new_page', leagueUrl], { timeout: 90_000 });
  else if (!onYahoo.selected) cd(['select_page', String(onYahoo.id)]);

  for (let i = 0; i < 2; i++) {
    try {
      const ok = runJs(
        `async () => { const r = await fetch('${new URL(leagueUrl).pathname}', {credentials:'include'});
         const t = await r.text();
         return JSON.stringify({s: r.status, login: /Sign in|login_verify/i.test(t) && t.length < 60000}); }`,
        { retries: 0 });
      if (ok.s === 200 && !ok.login) return true;
    } catch { /* fall through to reload */ }
    cd(['navigate_page', '--url', leagueUrl, '--timeout', '45000'], { timeout: 90_000 });
    sleep(3000);
  }
  throw new Error('Yahoo page canary failed — stale tab, network, or signed out');
}
