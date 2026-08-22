// Compact draft-room state. One call, small payload.
// Never returns anything snapshot-sized — take_snapshot here is ~118k chars.

async () => {
  const body = document.body.innerText.replace(/\s+/g, ' ').trim();
  // Header only. The player board contains its own "YOUR TURN - Nth PICK"
  // divider rows, which false-positive a whole-body match.
  const head = body.slice(0, 220);
  const clock = head.match(/\b(\d{1,2}):(\d{2})\b/);
  const pickM = head.match(/ROUND\s+(\d+),?\s+PICK\s+(\d+)/i);
  const upIn = head.match(/up in (\d+) Pick/i);
  const teamM = body.match(/YOUR TEAM \((\d+)\/(\d+)\)/i);

  // The board is the one table whose header carries ADP. Scope to it explicitly:
  // `.ys-player[data-id]` also appears in the roster panel, and conflating them
  // is how roster resolution went wrong.
  const boardTable = [...document.querySelectorAll('table')]
    .find(t => [...t.querySelectorAll('thead th')].some(h => /^ADP$/i.test(h.textContent.trim())));
  const rows = boardTable
    ? [...boardTable.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('.ys-player[data-id]'))
    : [];
  const heads = boardTable
    ? [...boardTable.querySelectorAll('thead th')].map(t => t.textContent.trim()) : [];
  const iADP = heads.findIndex(h => /^ADP$/i.test(h));

  // Roster ids, exact by data-id (no name matching — surname parsing mangled
  // "Kenneth Walker III" into "III" and matched Bijan Robinson for Wan'Dale).
  //
  // MUST be scoped to the roster panel, NOT merely "outside the board table":
  // the QUEUE panel is also outside it, so counting both inflated the roster by
  // the queue depth. Mid-draft that pushed apparent roster size to 15, made
  // picksLeft 0, and caused the constraint layer to reject every legal pick.
  // Anchor on the panel carrying "YOUR TEAM (n/15)", smallest such container.
  // Anchor by STRUCTURE, not by player count. Requiring ">0 players" was a
  // regression: at the start of a draft the roster panel is empty, so the rule
  // walked outward to a wrapper that contained the whole board and reported 100
  // rostered players — which made picksLeft negative and every pick illegal.
  //
  // Correct test: smallest container that mentions "YOUR TEAM (" and does NOT
  // contain the board table. An empty result is legitimate and expected early.
  const rosterRoot = [...document.querySelectorAll('div,section,aside')]
    .filter(el => /YOUR TEAM \(/.test(el.textContent || '')
      && (!boardTable || !el.contains(boardTable)))
    .sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length)[0] || null;

  const rosterIds = rosterRoot
    ? [...new Set([...rosterRoot.querySelectorAll('.ys-player[data-id]')]
        .map(el => el.getAttribute('data-id')))]
    : [];

  const avail = [], adp = {};
  for (const tr of rows) {
    const id = tr.querySelector('.ys-player[data-id]').getAttribute('data-id');
    if (avail.includes(id)) continue;
    avail.push(id);
    if (iADP >= 0) {
      const v = parseFloat([...tr.querySelectorAll('td')][iADP]?.textContent.trim());
      if (Number.isFinite(v)) adp[id] = v;
    }
  }

  const queued = rows
    .filter(tr => tr.querySelector('svg[data-icon="star-filled"]'))
    .map(tr => tr.querySelector('.ys-player[data-id]').getAttribute('data-id'));

  const i = body.indexOf('YOUR TEAM');

  return JSON.stringify({
    onClock: /YOUR TURN\s*[•·]/i.test(head),
    secondsLeft: clock ? (+clock[1]) * 60 + (+clock[2]) : null,
    round: pickM ? +pickM[1] : null,
    pickNo: pickM ? +pickM[2] : null,
    picksUntilMine: upIn ? +upIn[1] : null,
    rosterCount: teamM ? +teamM[1] : null,
    rosterIds,
    rosterText: i >= 0 ? body.slice(i, i + 700) : '',
    autopick: /put into autopick/i.test(body),
    complete: /Draft Complete/i.test(body),
    // Draft controls exist only while on the clock; stars only while off it.
    draftBtns: [...document.querySelectorAll('button')]
      .filter(b => /^draft$/i.test(b.textContent.trim())).length,
    avail, adp, queued,
  });
}
