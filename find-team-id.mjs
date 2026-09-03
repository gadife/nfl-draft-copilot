import { ensureYahooPage, runJs } from './lib/cdp.mjs';
import config from './config.json' with { type: 'json' };

const url = config.league.url;
ensureYahooPage(url);

const result = runJs(`async () => {
  const links = Array.from(document.querySelectorAll('a[href*="/f1/${config.league.id}/"]'))
    .map(a => ({ text: a.textContent.trim(), href: a.href }))
    .filter(l => l.text.length > 0);
  return JSON.stringify(links.slice(0, 60));
}`);

console.log(JSON.stringify(result, null, 2));
