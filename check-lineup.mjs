import { ensureYahooPage, runJs, cd } from './lib/cdp.mjs';
import config from './config.json' with { type: 'json' };

const teamId = 12;
const url = `${config.league.url}/${teamId}/team?&week=1`;
ensureYahooPage(config.league.url);
cd(['navigate_page', '--url', url, '--timeout', '45000'], { timeout: 90_000 });

const result = runJs(`async () => {
  const rows = Array.from(document.querySelectorAll('table tr')).filter(tr => tr.querySelector('.ysf-player-name, .Nowrap a[href*="/players/"]'));
  const out = rows.map(tr => {
    const posCell = tr.querySelector('td')?.textContent?.trim();
    const nameLink = tr.querySelector('a[href*="/players/"]');
    const name = nameLink ? nameLink.textContent.trim() : null;
    return { pos: posCell, name };
  }).filter(r => r.name);
  return JSON.stringify({ url: location.href, rows: out });
}`);

console.log(JSON.stringify(result, null, 2));
