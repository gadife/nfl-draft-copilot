import { ensureYahooPage, runJs, cd } from './lib/cdp.mjs';
import config from './config.json' with { type: 'json' };

const url = `${config.league.url}/players?status=A&pos=O&stat1=S_S_2026&sort=AR&sdir=1`;
ensureYahooPage(config.league.url);
cd(['navigate_page', '--url', url, '--timeout', '45000'], { timeout: 90_000 });

const result = runJs(`async () => {
  const rows = Array.from(document.querySelectorAll('table tr')).filter(tr => tr.querySelector('a[href*="/players/"]'));
  const out = rows.map(tr => {
    const nameLink = tr.querySelector('a[href*="/players/"]');
    const name = nameLink ? nameLink.textContent.trim() : null;
    const posTeam = tr.querySelector('.ysf-player-name, .Alt')?.parentElement?.textContent?.replace(/\\s+/g,' ').trim();
    const fullText = tr.textContent.replace(/\\s+/g,' ').trim();
    return { name, fullText: fullText.slice(0, 160) };
  }).filter(r => r.name);
  return JSON.stringify({ url: location.href, count: out.length, rows: out.slice(0, 40) });
}`);

console.log(JSON.stringify(result, null, 2));
