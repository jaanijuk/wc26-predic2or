// Pulls FIFA World Cup 2026 results from the free, public-domain openfootball
// feed and writes them into Supabase. Runs on a schedule via GitHub Actions.
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (service key bypasses RLS).
import { createClient } from "@supabase/supabase-js";

const FEED = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const isPlaceholder = (s) => !s || /^[0-9]/.test(s) || /^[WL]\d/.test(s);

function advancer(t1, t2, score) {
  const ft = score?.ft; if (!ft) return null;
  if (ft[0] !== ft[1]) return ft[0] > ft[1] ? t1 : t2;       // decided in 90'
  const p = score.p || score.pen;                            // penalties if present
  if (Array.isArray(p) && p[0] !== p[1]) return p[0] > p[1] ? t1 : t2;
  return null;                                               // draw, pens unknown → admin fills in
}

const run = async () => {
  const feed = await (await fetch(FEED)).json();
  const { data: ours, error } = await sb.from("matches").select("no,round,team_a,team_b,knockout");
  if (error) throw error;

  // index our group matches by "teamA|teamB"
  const groupIdx = {};
  ours.filter(m => !m.knockout && m.team_a && m.team_b)
      .forEach(m => groupIdx[`${m.team_a}|${m.team_b}`] = m.no);

  let updated = 0;
  for (const m of feed.matches) {
    let no = null;
    if (m.group) no = groupIdx[`${m.team1}|${m.team2}`];
    else if (m.num) no = m.num;                               // KO 73–102
    else if (m.round === "Match for third place") no = 103;
    else if (m.round === "Final") no = 104;
    if (!no) continue;

    const patch = {};
    // resolve knockout teams once the feed reveals them
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
  console.log(`Updated ${updated} matches at ${new Date().toISOString()}`);
};
run().catch(e => { console.error(e); process.exit(1); });
