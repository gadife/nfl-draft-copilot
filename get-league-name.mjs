// One-off: scrape the live league name from Yahoo via the logged-in Chrome
// session (same CDP pattern as draft-night tooling). Run manually whenever
// you want to refresh roster.html's header before redeploying.
import { ensureYahooPage, runJs } from './lib/cdp.mjs';
import config from './config.json' with { type: 'json' };

const url = config.league.url;
ensureYahooPage(url);

const result = runJs(`async () => {
  const title = document.title;
  const h1 = document.querySelector('h1')?.textContent?.trim() || null;
  const metaOg = document.querySelector('meta[property="og:title"]')?.content || null;
  return JSON.stringify({ title, h1, metaOg });
}`);

console.log(JSON.stringify(result, null, 2));
