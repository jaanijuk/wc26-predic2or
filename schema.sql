-- ============================================================================
--  World Cup 2026 Predictor — database schema (Supabase / PostgreSQL)
--  Run this whole file ONCE in the Supabase SQL editor, then run seed_matches.sql
-- ============================================================================

create extension if not exists pgcrypto;   -- for PIN hashing

-- ---------- TABLES ----------------------------------------------------------
create table if not exists players (
  name       text primary key,
  pin_hash   text,                       -- set on first login ("claim your name")
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists matches (
  no              int primary key,
  round           text not null,
  label           text not null,         -- e.g. "Group A" / "Quarter-final"
  slot_a          text,                  -- knockout placeholder e.g. "1E" / "W74"
  slot_b          text,
  team_a          text,                  -- resolved team (null for KO until known)
  team_b          text,
  venue           text,
  kickoff_utc     timestamptz not null,
  mult            int  not null default 1,
  knockout        boolean not null default false,
  actual_a        int,                   -- actual 90-min score
  actual_b        int,
  actual_advancer text,                  -- KO only: team that progressed
  status          text not null default 'scheduled'  -- 'scheduled' | 'final'
);

create table if not exists predictions (
  player        text not null references players(name) on delete cascade,
  match_no      int  not null references matches(no)   on delete cascade,
  pred_a        int  not null,
  pred_b        int  not null,
  pred_advancer text,
  updated_at    timestamptz not null default now(),
  primary key (player, match_no)
);

-- seed the five players (PINs are claimed on first login).
insert into players (name, is_admin) values
  ('Adi',false),('CJ',false),('JJ',true),('Joe',false),('Claude',false)
on conflict (name) do nothing;
-- NOTE: JJ is the default results admin. Change with:  update players set is_admin=true where name='Joe';

-- ---------- ROW LEVEL SECURITY ----------------------------------------------
alter table players      enable row level security;
alter table matches      enable row level security;
alter table predictions  enable row level security;

-- matches: world-readable (full transparency of schedule + results)
drop policy if exists matches_read on matches;
create policy matches_read on matches for select using (true);

-- players & predictions: NO direct read/write policies.
-- All access goes through the SECURITY DEFINER functions / views below,
-- so PINs stay private and picks stay hidden until kickoff.

-- ---------- HELPER: lock check ----------------------------------------------
-- A match is "open" only when both teams are known and kickoff is in the future.

-- ---------- AUTH: claim-on-first-use + verify -------------------------------
create or replace function login_player(p_name text, p_pin text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  select pin_hash into h from players where name = p_name;
  if not found then
    raise exception 'Unknown player %', p_name;
  end if;
  if h is null then                       -- first login claims the PIN
    update players set pin_hash = crypt(p_pin, gen_salt('bf')) where name = p_name;
    return true;
  end if;
  return crypt(p_pin, h) = h;             -- verify
end $$;

-- ---------- SUBMIT A PREDICTION (server-enforced HARD LOCK) -----------------
create or replace function submit_prediction(
  p_name text, p_pin text, p_match int,
  p_a int, p_b int, p_advancer text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; h text;
begin
  select pin_hash into h from players where name = p_name;
  if h is null or crypt(p_pin, h) <> h then
    raise exception 'Wrong PIN';
  end if;
  select * into m from matches where no = p_match;
  if not found then raise exception 'No such match'; end if;
  if m.team_a is null or m.team_b is null then
    raise exception 'Teams for this match are not decided yet';
  end if;
  if now() >= m.kickoff_utc then
    raise exception 'Locked — this match has kicked off';   -- THE HARD LOCK
  end if;
  if p_a < 0 or p_b < 0 then raise exception 'Scores must be 0 or more'; end if;
  if m.knockout and p_advancer is not null
     and p_advancer not in (m.team_a, m.team_b) then
    raise exception 'Advancer must be one of the two teams';
  end if;

  insert into predictions (player, match_no, pred_a, pred_b, pred_advancer, updated_at)
  values (p_name, p_match, p_a, p_b, p_advancer, now())
  on conflict (player, match_no) do update
    set pred_a = excluded.pred_a, pred_b = excluded.pred_b,
        pred_advancer = excluded.pred_advancer, updated_at = now();
  return 'saved';
end $$;

-- ---------- READ YOUR OWN PICKS (any time, with PIN) ------------------------
create or replace function get_my_predictions(p_name text, p_pin text)
returns table (match_no int, pred_a int, pred_b int, pred_advancer text)
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  select pin_hash into h from players where name = p_name;
  if h is null or crypt(p_pin, h) <> h then raise exception 'Wrong PIN'; end if;
  return query
    select p.match_no, p.pred_a, p.pred_b, p.pred_advancer
    from predictions p where p.player = p_name;
end $$;

-- ---------- ADMIN: enter / override a result --------------------------------
create or replace function set_result(
  p_name text, p_pin text, p_match int,
  p_a int, p_b int, p_advancer text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare h text; adm boolean;
begin
  select pin_hash, is_admin into h, adm from players where name = p_name;
  if h is null or crypt(p_pin, h) <> h then raise exception 'Wrong PIN'; end if;
  if not coalesce(adm,false) then raise exception 'Not an admin'; end if;
  update matches
     set actual_a = p_a, actual_b = p_b,
         actual_advancer = p_advancer,
         status = case when p_a is null then 'scheduled' else 'final' end
   where no = p_match;
  return 'result saved';
end $$;

-- ---------- VIEWS (owned by postgres → bypass RLS safely) -------------------
-- public list of players for the login screen (no PIN exposed)
create or replace view v_players as
  select name, is_admin from players order by name;

-- everyone's picks, but ONLY revealed once a match has kicked off
create or replace view v_public_predictions as
  select p.match_no, p.player, p.pred_a, p.pred_b, p.pred_advancer
  from predictions p
  join matches m on m.no = p.match_no
  where now() >= m.kickoff_utc;

-- per-pick points for finished matches (the scoring engine, in SQL)
create or replace view v_scores as
  select
    p.player, p.match_no, m.round, m.mult,
    (case
       when p.pred_a = m.actual_a and p.pred_b = m.actual_b then 5
       when sign(p.pred_a - p.pred_b) = sign(m.actual_a - m.actual_b)
            then 2 + (case when (p.pred_a - p.pred_b) = (m.actual_a - m.actual_b) then 1 else 0 end)
       else 0
     end
     + case when m.knockout and p.pred_advancer is not null
                 and p.pred_advancer = m.actual_advancer then 3 else 0 end
    ) * m.mult as points
  from predictions p
  join matches m on m.no = p.match_no
  where m.status = 'final' and m.actual_a is not null and m.actual_b is not null;

-- leaderboard: every player, total + exacts, even on zero
create or replace view v_leaderboard as
  select pl.name as player,
         coalesce(sum(s.points),0)                                   as total,
         count(s.match_no) filter (where s.points > 0)               as scoring_picks,
         count(s.match_no) filter (where s.points = s.mult*5
                                     or  s.points = s.mult*8)        as exact_scores
  from players pl
  left join v_scores s on s.player = pl.name
  group by pl.name
  order by total desc, exact_scores desc, player;

-- ---------- GRANTS ----------------------------------------------------------
grant select on matches, v_players, v_public_predictions, v_scores, v_leaderboard
  to anon, authenticated;
grant execute on function
  login_player(text,text),
  submit_prediction(text,text,int,int,int,text),
  get_my_predictions(text,text),
  set_result(text,text,int,int,int,text)
  to anon, authenticated;
