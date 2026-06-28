// Pulls FIFA World Cup 2026 results from the free, public-domain openfootball
// feed and writes them into Supabase. Runs on a schedule via GitHub Actions.
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (service key bypasses RLS).
//
// In addition to importing the feed, after each run it RESOLVES knockout
// fixtures from the group results we already store, so the bracket fills in
// without waiting for openfootball to publish the knockout team names:
//   • 1X / 2X    group winner / runner-up   (deterministic from standings)
//   • 3.../...   best-third slots            (FIFA allocation table, see THIRD_ALLOC)
//   • W## / L##  winner / loser of match ##  (deterministic from results)
// It only ever writes a team it can resolve with certainty and never overwrites
// a team already set to a real name — so edge cases are safely left for the
// admin Results tab rather than guessed.

import { createClient } from "@supabase/supabase-js";

const FEED = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

const isPlaceholder = (s) => !s || /^[0-9]/.test(s) || /^[WL]\d/.test(s);

function advancer(t1, t2, score) {
  const ft = score?.ft; if (!ft) return null;
  if (ft[0] !== ft[1]) return ft[0] > ft[1] ? t1 : t2;       // decided in 90'
  const p = score.p || score.pen;                            // penalties if present
  if (Array.isArray(p) && p[0] !== p[1]) return p[0] > p[1] ? t1 : t2;
  return null;                                               // draw, pens unknown → admin fills in
}

// ── FIFA best-third allocation ──────────────────────────────────────────────
// Which team fills each "3…/…" R32 slot depends on WHICH eight third-placed
// teams qualify; it follows FIFA's fixed allocation table and can't be derived
// from points alone. Keyed by the sorted set of qualifying third-place groups,
// mapping each slot string to the group whose third-placed team goes there.
// Pre-filled for the 2026 qualifying set {B,D,E,F,I,J,K,L}. If a different set
// ever qualifies, add an entry; unknown sets are skipped (left for the admin),
// never guessed.
const THIRD_ALLOC = {
  "B,D,E,F,I,J,K,L": {
    "3A/B/C/D/F": "D", "3C/D/F/G/H": "F", "3C/E/F/H/I": "E", "3E/H/I/J/K": "K",
    "3B/E/F/I/J": "B", "3A/E/H/I/J": "I", "3E/F/G/I/J": "J", "3D/E/I/J/L": "L",
  },
};

// Group / thirds ordering. Simplified FIFA tiebreak: points, then goal
// difference, then goals for (name as a last-resort stable sort). Exotic
// head-to-head ties should be confirmed via the admin Results tab — this never
// overwrites a team already set to a real name.
const orderTeams = (arr) =>
  arr.slice().sort((x, y) =>
    y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team));

function buildStandings(all) {
  const groups = {};
  for (const m of all) {
    if (m.knockout || m.status !== "final" || m.actual_a == null) continue;
    const g = (m.label || "").replace(/^Group\s+/i, "").trim();
    if (!g || !m.team_a || !m.team_b) continue;
    const G = (groups[g] = groups[g] || {});
    const A = (G[m.team_a] = G[m.team_a] || { team: m.team_a, pl: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
    const B = (G[m.team_b] = G[m.team_b] || { team: m.team_b, pl: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
    A.pl++; B.pl++;
    A.gf += m.actual_a; A.ga += m.actual_b;
    B.gf += m.actual_b; B.ga += m.actual_a;
    if (m.actual_a > m.actual_b) A.pts += 3;
    else if (m.actual_a < m.actual_b) B.pts += 3;
    else { A.pts++; B.pts++; }
  }
  const standings = {};
  for (const g in groups) {
    const teams = Object.values(groups[g]);
    teams.forEach((t) => (t.gd = t.gf - t.ga));
    // only trust a group once all four teams have completed their three matches
    if (teams.length === 4 && teams.every((t) => t.pl === 3)) standings[g] = orderTeams(teams);
  }
  return standings;
}

function qualifyingThirdsKey(standings) {
  const groupLetters = Object.keys(standings);
  if (groupLetters.length < 12) return null;                 // need every group complete
  const thirds = groupLetters.map((g) => ({ g, ...standings[g][2] }));
  return orderTeams(thirds).slice(0, 8).map((t) => t.g).sort().join(",");
}

function makeResolver(all, standings) {
  const byNo = Object.fromEntries(all.map((m) => [m.no, m]));
  const qualKey = qualifyingThirdsKey(standings);
  const winnerOf = (no) => {
    const m = byNo[no]; if (!m || m.status !== "final") return null;
    if (m.actual_advancer) return m.actual_advancer;
    if (m.actual_a != null && m.actual_a !== m.actual_b) return m.actual_a > m.actual_b ? m.team_a : m.team_b;
    return null;
  };
  const loserOf = (no) => {
    const m = byNo[no]; const w = winnerOf(no); if (!m || !w) return null;
    return w === m.team_a ? m.team_b : m.team_a;
  };
  return (slot) => {
    if (!slot) return null;
    let mm;
    if ((mm = slot.match(/^([12])([A-L])$/)))                // 1X / 2X
      return standings[mm[2]]?.[mm[1] === "1" ? 0 : 1]?.team || null;
    if (/^3[A-L/]+$/.test(slot)) {                           // 3…/… best third
      const map = qualKey && THIRD_ALLOC[qualKey];
      const g = map && map[slot];
      return g ? standings[g]?.[2]?.team || null : null;
    }
    if ((mm = slot.match(/^W(\d+)$/))) return winnerOf(+mm[1]);
    if ((mm = slot.match(/^L(\d+)$/))) return loserOf(+mm[1]);
    return null;
  };
}

// Pure: returns [{no, patch}] for knockout rows whose team_a/team_b can be
// resolved and aren't already set to a real team. Exported for testing.
export function computeResolutions(all) {
  const standings = buildStandings(all);
  const resolve = makeResolver(all, standings);
  const out = [];
  for (const m of all) {
    if (!m.knockout) continue;
    const patch = {};
    if (isPlaceholder(m.team_a)) { const t = resolve(m.slot_a); if (t) patch.team_a = t; }
    if (isPlaceholder(m.team_b)) { const t = resolve(m.slot_b); if (t) patch.team_b = t; }
    if (Object.keys(patch).length) out.push({ no: m.no, patch });
  }
  return out;
}

const run = async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  const feed = await (await fetch(FEED)).json();
  const { data: ours, error } = await sb.from("matches")
    .select("no,round,label,slot_a,slot_b,team_a,team_b,actual_a,actual_b,actual_advancer,status,knockout");
  if (error) throw error;

  // index our group matches by "teamA|teamB"
  const groupIdx = {};
  ours.filter((m) => !m.knockout && m.team_a && m.team_b)
      .forEach((m) => (groupIdx[`${m.team_a}|${m.team_b}`] = m.no));

  let updated = 0;
  for (const m of feed.matches) {
    let no = null;
    if (m.group) no = groupIdx[`${m.team1}|${m.team2}`];
    else if (m.num) no = m.num;                               // KO 73–102
    else if (m.round === "Match for third place") no = 103;
    else if (m.round === "Final") no = 104;
    if (!no) continue;

    const patch = {};
    // resolve knockout teams if the feed itself reveals them (we also derive them below)
    if (!m.group) {
      if (!isPlaceholder(m.team1)) patch.team_a = m.team1;
      if (!isPlaceholder(m.team2)) patch.team_b = m.team2;
    }
    // results
    if (m.score?.ft) {
      patch.actual_a = m.score.ft[0];
      patch.actual_b = m.score.ft[1];
      patch.status = "final";
      if (!m.group) {
        const adv = advancer(m.team1, m.team2, m.score);
        if (adv) patch.actual_advancer = adv;
      }
    }
    if (Object.keys(patch).length) {
      const { error: e } = await sb.from("matches").update(patch).eq("no", no);
      if (e) console.error(`#${no}`, e.message); else updated++;
    }
  }

  // ── derive knockout fixtures from the results we now hold ──
  // re-read so the freshly-written results are included
  const { data: fresh, error: e2 } = await sb.from("matches")
    .select("no,label,slot_a,slot_b,team_a,team_b,actual_a,actual_b,actual_advancer,status,knockout");
  if (e2) throw e2;
  let resolved = 0;
  for (const { no, patch } of computeResolutions(fresh || [])) {
    const { error: e } = await sb.from("matches").update(patch).eq("no", no);
    if (e) console.error(`resolve #${no}`, e.message); else resolved++;
  }

  console.log(`Updated ${updated} results, resolved ${resolved} knockout teams at ${new Date().toISOString()}`);
};

// only run when invoked directly (so tests can import the pure functions)
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
