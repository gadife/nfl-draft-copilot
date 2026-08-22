// Act on the draft room: draft, or rebuild the queue.
// Parameters MODE / IDS are substituted by mock.mjs before evaluation.

async () => {
  const MODE = '__MODE__';
  const IDS = __IDS__;
  const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

  // Find the nearest ancestor that actually carries a Draft control.
  //
  // Do NOT use .closest('tr'): the QUEUE panel renders players outside any
  // table, and the board is virtualised to ~100 rows, so a player can vanish
  // from the table while still being draftable from the queue. Requiring a <tr>
  // reported those as "no-row" and skipped them — which is why the same player
  // (34008) was skipped at picks 72 and 96, twenty-four picks apart.
  const hostOf = (id) => {
    const els = [...document.querySelectorAll(`.ys-player[data-id="${id}"]`)];
    for (const el of els) {
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        if (n.querySelectorAll && [...n.querySelectorAll('button')].some(b => /^draft$/i.test(txt(b)))) return n;
        n = n.parentElement;
      }
    }
    // Fall back to a table row if one exists, so behaviour is never worse.
    return els[0]?.closest('tr') ?? null;
  };
  const rowOf = hostOf;

  if (MODE === 'draft') {
    // Every fallback ships in THIS call. A candidate sniped mid-flight then
    // costs nothing instead of a second round-trip — this saved pick 57 in
    // live mock #1 when Montgomery went between compute and click.
    // Why a candidate was skipped matters: "row gone" means the board moved on,
    // "button missing/disabled" means our availability model is wrong. In mock
    // #2 every pick fell through to a fallback and the logs could not tell
    // these apart.
    const skipped = [];
    for (const id of IDS) {
      const tr = rowOf(id);
      if (!tr) { skipped.push(id + ':no-row'); continue; }
      const anyBtn = [...tr.querySelectorAll('button')].filter(b => /^draft$/i.test(txt(b)));
      const btn = anyBtn.find(b => !b.disabled);
      if (!btn) {
        skipped.push(id + (anyBtn.length ? ':btn-disabled' : ':no-btn'));
        continue;
      }
      btn.click();
      await new Promise(r => setTimeout(r, 650));
      const confirm = [...document.querySelectorAll('button')]
        .find(b => /^(yes|confirm|draft player|ok)$/i.test(txt(b)));
      if (confirm) { confirm.click(); await new Promise(r => setTimeout(r, 250)); }
      const body = document.body.innerText.replace(/\s+/g, ' ');
      return JSON.stringify({ picked: id, skipped,
        roster: (body.match(/YOUR TEAM \((\d+)\//) || [])[1] });
    }
    return JSON.stringify({ picked: null, tried: IDS.length, skipped });
  }

  if (MODE === 'queue') {
    // CLEAR then RE-ADD in order. Appending alone puts new entries at the
    // BOTTOM, so a stale entry fires first — that is how live mock #1
    // autodrafted a backup QB ahead of an empty WR2.
    const cleared = [];
    for (const tr of [...document.querySelectorAll('tr')]) {
      const filled = tr.querySelector('svg[data-icon="star-filled"]');
      if (!filled) continue;
      const id = tr.querySelector('.ys-player[data-id]')?.getAttribute('data-id');
      if (IDS.includes(id)) { /* still wanted, but order matters -> clear anyway */ }
      const btn = filled.closest('button');
      if (btn) { btn.click(); cleared.push(id); await new Promise(r => setTimeout(r, 260)); }
    }
    const added = [];
    for (const id of IDS) {
      const tr = rowOf(id);
      const btn = tr?.querySelector('svg[data-icon="star-unfilled"]')?.closest('button');
      if (!btn) { added.push(id + ':miss'); continue; }
      btn.click();
      await new Promise(r => setTimeout(r, 280));
      added.push(id + (tr.querySelector('svg[data-icon="star-filled"]') ? ':ok' : ':?'));
    }
    return JSON.stringify({ cleared, added });
  }

  return JSON.stringify({ error: 'bad mode', MODE });
}
