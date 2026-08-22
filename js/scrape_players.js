// Scrape one (position, statMode) slice of Yahoo's league-scoped players table.
//
// Runs in-page so the authenticated session cookie rides along on same-origin
// fetch(). Paginates 25 rows at a time until a page comes back empty.
//
// Column keys are "Group|Leaf" (e.g. "Receiving|TD") because the leaf labels
// alone are ambiguous: offense has four columns literally named "TD", and DEF
// has two. Header indexes are NEVER hardcoded — the column set differs by
// position, which is exactly why we shard by position.
//
// Invoked via cdp.runJs with LEAGUE/POS/STAT/MAXPAGES substituted.

async (LEAGUE, POS, STAT, MAXPAGES) => {
  const MAIN = 'table.Table-interactive';
  // Yahoo salts headers and cells with private-use-area glyphs (sort arrows,
  // game-status icons). Strip them or they end up inside column keys.
  const txt = (el) => (el ? el.textContent : '')
    .replace(/[-]/g, '').replace(/\s+/g, ' ').trim();

  // Expand a header row's colspans into one entry per leaf column.
  const expand = (tr) => {
    const out = [];
    for (const th of tr.querySelectorAll('th')) {
      const label = txt(th);
      for (let i = 0; i < (th.colSpan || 1); i++) out.push(label);
    }
    return out;
  };

  const players = [];
  const seen = new Set();
  let headerKeys = null;
  let pages = 0;

  for (let count = 0; pages < MAXPAGES; count += 25, pages++) {
    const url = `/f1/${LEAGUE}/players?status=ALL&pos=${encodeURIComponent(POS)}`
      + `&stat1=${STAT}&count=${count}&sort=PTS&sdir=1`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}`, url, players });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

    const table = doc.querySelector(MAIN);
    if (!table) break;

    if (!headerKeys) {
      const hrows = [...table.querySelectorAll('thead tr')];
      const leaf = expand(hrows[hrows.length - 1]);
      const grp = hrows.length > 1 ? expand(hrows[0]) : leaf.map(() => '');
      headerKeys = leaf.map((l, i) => {
        const g = (grp[i] || '').trim();
        return g && g !== l ? `${g}|${l}` : l;
      });
    }

    const rows = [...table.querySelectorAll('tbody tr')];
    let added = 0;
    for (const tr of rows) {
      const a = tr.querySelector('a.playernote[data-ys-playerid]')
        || tr.querySelector('[data-ys-playerid]');
      if (!a) continue;
      const id = a.getAttribute('data-ys-playerid');
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // "Hou - DEF" / "LAR - WR,RB" sits in the meta span under the name.
      // Require spaces around the dash AND a real position token, or hyphenated
      // surnames get shredded: "Jaxon Smith-Njigba" otherwise yields team "ith".
      const meta = txt(tr.querySelector('td:nth-child(3)'));
      const mt = meta.match(/\b([A-Za-z]{2,3})\s-\s((?:QB|RB|WR|TE|K|DEF)(?:[,/](?:QB|RB|WR|TE|K|DEF))*)\b/);

      const cells = [...tr.querySelectorAll('td')].map(td => txt(td));
      const cols = {};
      headerKeys.forEach((k, i) => { if (k && cells[i] !== undefined) cols[k] = cells[i]; });

      players.push({
        id,
        name: a.getAttribute('title') || txt(a),
        team: mt ? mt[1] : null,
        posRaw: mt ? mt[2] : POS,
        // Injury badge: Q, D, O, IR, PUP, NA, SUS. Absent when healthy.
        // Must be `.ysf-player-status` — the unprefixed `.player-status` is the
        // video/notes container and matches on every single row.
        status: txt(tr.querySelector('.ysf-player-status')) || null,
        statusLong: (tr.querySelector('td:nth-child(3) span[title]') || {}).title || null,
        cols,
      });
      added++;
    }
    if (added === 0) break;
  }

  return JSON.stringify({ pos: POS, stat: STAT, headerKeys, count: players.length, players });
}
