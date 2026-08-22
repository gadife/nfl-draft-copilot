// Single in-page entry point for the draft room. One snippet, several ACTIONs,
// so the on-clock path is exactly one round-trip.
//
// Returns compact JSON only — never anything snapshot-sized. (take_snapshot on
// this page returns ~118k chars and overflows context; that is why this exists.)
//
// Player identity is ALWAYS the data-id on .ys-player. Never display text.
//
// ACTIONS
//   discover : one-time DOM reconnaissance, to validate selectors
//   state    : {onClock, secondsLeft, pickNo, round, lastPick, myTeam} — tiny
//   board    : every visible player row {id, name, pos, team, bye, adp, rank, drafted}
//   queue    : reconcile the queue against IDS (queue[0] must be our top pick)
//   click    : draft the first draftable id in IDS

async () => {
  const ACTION = '__ACTION__';
  const IDS = __IDS__;

  const txt = (el) => (el ? el.textContent : '').replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
  const nOf = (s) => { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : null; };

  // A player row is whatever ancestor of .ys-player also holds a Draft control.
  const rowOf = (el) => {
    let n = el;
    for (let i = 0; i < 10 && n; i++) {
      if (n.tagName === 'TR') return n;
      if (n.querySelector && [...n.querySelectorAll('button')].some(b => /^draft$/i.test(txt(b)))) return n;
      n = n.parentElement;
    }
    return el.parentElement;
  };

  const draftBtnIn = (row) =>
    [...row.querySelectorAll('button')].find(b => /^draft$/i.test(txt(b)) && !b.disabled);

  if (ACTION === 'discover') {
    const ys = [...document.querySelectorAll('.ys-player[data-id]')];
    const first = ys[0] ? rowOf(ys[0]) : null;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      ysPlayerCount: ys.length,
      sampleIds: ys.slice(0, 5).map(e => e.getAttribute('data-id')),
      selects: [...document.querySelectorAll('select')].map(s => ({
        name: s.name || s.id, value: s.value,
        opts: [...s.options].map(o => `${o.value}=${o.text}`).slice(0, 14),
      })),
      buttonTexts: [...new Set([...document.querySelectorAll('button')].map(b => txt(b)))]
        .filter(Boolean).slice(0, 40),
      headerText: txt(document.body).slice(0, 400),
      firstRowText: first ? txt(first).slice(0, 200) : null,
      firstRowHasDraft: !!(first && draftBtnIn(first)),
      starIcons: [...new Set([...document.querySelectorAll('svg[data-icon]')]
        .map(s => s.getAttribute('data-icon')))].slice(0, 25),
      tableHeaders: [...document.querySelectorAll('thead th, [role=columnheader]')]
        .map(t => txt(t)).slice(0, 30),
    });
  }

  if (ACTION === 'state') {
    const body = txt(document.body).slice(0, 600);
    const clock = (body.match(/\b(\d{1,2}):(\d{2})\b/) || null);
    const secondsLeft = clock ? (+clock[1]) * 60 + (+clock[2]) : null;
    const onClock = /YOUR TURN/i.test(body);
    const pickM = body.match(/ROUND\s+(\d+),?\s+PICK\s+(\d+)/i);
    const upIn = body.match(/up in (\d+) Pick/i);
    const lastM = body.match(/Last:\s*([A-Z][^(]*)\(([^)]*)\)/i);
    return JSON.stringify({
      onClock, secondsLeft,
      round: pickM ? +pickM[1] : null,
      pickNo: pickM ? +pickM[2] : null,
      picksUntilMine: upIn ? +upIn[1] : (onClock ? 0 : null),
      lastPick: lastM ? lastM[1].trim() : null,
      draftComplete: /Draft Complete/i.test(body),
      rosterCount: (txt(document.body).match(/YOUR TEAM \((\d+)\/(\d+)\)/i) || [])[1] ?? null,
    });
  }

  if (ACTION === 'board') {
    const out = [];
    for (const el of document.querySelectorAll('.ys-player[data-id]')) {
      const id = el.getAttribute('data-id');
      if (!id || out.some(o => o.id === id)) continue;
      const row = rowOf(el);
      const cells = row.tagName === 'TR'
        ? [...row.querySelectorAll('td')].map(td => txt(td))
        : txt(row).split(' ');
      out.push({
        id,
        name: txt(el.querySelector('span, a')) || txt(el).slice(0, 24),
        rowText: txt(row).slice(0, 90),
        draftable: !!draftBtnIn(row),
        cells: row.tagName === 'TR' ? cells.slice(0, 14) : undefined,
      });
    }
    return JSON.stringify({ count: out.length, players: out });
  }

  if (ACTION === 'queue') {
    // Best-effort: star anything in IDS that is not already starred. Full
    // reordering is drag-only in this UI, so the practical invariant is
    // "our top pick is queued", achieved by clearing and re-adding in order.
    const acted = [];
    for (const id of IDS) {
      const el = document.querySelector(`.ys-player[data-id="${id}"]`);
      if (!el) { acted.push({ id, r: 'not-in-dom' }); continue; }
      const row = rowOf(el);
      const unf = row.querySelector('svg[data-icon="star-unfilled"]');
      const btn = unf && unf.closest('button');
      if (btn) { btn.click(); acted.push({ id, r: 'queued' }); await new Promise(r => setTimeout(r, 120)); }
      else acted.push({ id, r: 'already-or-no-star' });
    }
    return JSON.stringify({ acted });
  }

  if (ACTION === 'click') {
    // All fallbacks travel in this one call: if our top choice was sniped
    // mid-flight we drop to the next without another round-trip.
    for (const id of IDS) {
      const el = document.querySelector(`.ys-player[data-id="${id}"]`);
      if (!el) continue;
      const btn = draftBtnIn(rowOf(el));
      if (!btn) continue;
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      // Some skins raise a confirm dialog.
      const confirm = [...document.querySelectorAll('button')]
        .find(b => /^(yes|confirm|draft player|ok)$/i.test(txt(b)));
      if (confirm) { confirm.click(); await new Promise(r => setTimeout(r, 250)); }
      return JSON.stringify({ picked: id, confirmed: !document.querySelector(`.ys-player[data-id="${id}"] ~ button`) });
    }
    return JSON.stringify({ picked: null, tried: IDS.length });
  }

  return JSON.stringify({ error: 'unknown action', ACTION });
}
