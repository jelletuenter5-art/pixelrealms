-- PixelRealms Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  avatar_color TEXT DEFAULT '#4ade80',
  is_admin BOOLEAN DEFAULT FALSE,
  total_wins INTEGER DEFAULT 0,
  total_pixels_ever INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GAMES
-- ============================================================
CREATE TABLE games (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished')),
  category TEXT CHECK (category IN ('small','medium','big')),
  is_open BOOLEAN DEFAULT FALSE,         -- TRUE = the current joinable world for this category
  map_width INTEGER DEFAULT 100,
  map_height INTEGER DEFAULT 80,
  map_seed BIGINT DEFAULT floor(random() * 9999999),
  max_players INTEGER DEFAULT 20,
  current_players INTEGER DEFAULT 0,
  winner_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- Only one open (joinable) world per category at a time
CREATE UNIQUE INDEX idx_games_open_category ON games(category) WHERE is_open = TRUE;

-- ============================================================
-- COUNTRIES (a player's nation inside a game)
-- ============================================================
CREATE TABLE countries (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  player_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  flag_emoji TEXT DEFAULT '🏳️',
  pixel_count INTEGER DEFAULT 5,
  pending_pixels FLOAT DEFAULT 0,        -- accrued offline expansion tokens
  last_active TIMESTAMPTZ DEFAULT NOW(),
  gold INTEGER DEFAULT 100,
  income_per_pixel FLOAT DEFAULT 0.5,    -- gold per pixel per hour
  infrastructure_level INTEGER DEFAULT 0,
  army_size INTEGER DEFAULT 10,
  army_upkeep_per_pixel FLOAT DEFAULT 0.1,
  trade_partners UUID[] DEFAULT '{}',
  is_alive BOOLEAN DEFAULT TRUE,
  surrendered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(game_id, player_id),
  UNIQUE(game_id, name)
);

-- ============================================================
-- PIXELS (the map tiles)
-- ============================================================
CREATE TABLE pixels (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  terrain TEXT DEFAULT 'grass' CHECK (terrain IN ('water','grass','hill','mountain','desert')),
  country_id UUID REFERENCES countries(id) ON DELETE SET NULL,
  captured_at TIMESTAMPTZ,
  UNIQUE(game_id, x, y)
);

CREATE INDEX idx_pixels_game ON pixels(game_id);
CREATE INDEX idx_pixels_country ON pixels(country_id);

-- ============================================================
-- ATTACKS
-- ============================================================
CREATE TABLE attacks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  attacker_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  defender_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  pixel_x INTEGER NOT NULL,
  pixel_y INTEGER NOT NULL,
  success BOOLEAN,
  attacker_losses INTEGER DEFAULT 0,
  defender_losses INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRADE DEALS
-- ============================================================
CREATE TABLE trades (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  from_country_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  to_country_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  gold_offered INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ============================================================
-- INFRASTRUCTURE
-- ============================================================
CREATE TABLE infrastructure (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  country_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('farm','barracks','market','wall','mine')),
  pixel_x INTEGER,
  pixel_y INTEGER,
  level INTEGER DEFAULT 1,
  built_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GAME EVENTS (feed / log)
-- ============================================================
CREATE TABLE game_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  country_id UUID REFERENCES countries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_game ON game_events(game_id, created_at DESC);

-- ============================================================
-- MESSAGES (in-game chat)
-- ============================================================
CREATE TABLE messages (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pixels ENABLE ROW LEVEL SECURITY;
ALTER TABLE attacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE infrastructure ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Profiles: anyone can read, only owner can write
CREATE POLICY "profiles_read" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- Runs with elevated privileges so the profile row is created even
-- before the user's session/email is confirmed (RLS would otherwise
-- block the client-side insert in that window).
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'username');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- USERNAME LOGIN
-- Looks up the auth email for a given username so players can
-- sign in with just their username + password.
-- ============================================================
CREATE OR REPLACE FUNCTION get_email_for_username(input_username TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT au.email
  FROM auth.users au
  JOIN public.profiles p ON p.id = au.id
  WHERE p.username = input_username
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_email_for_username(TEXT) TO anon, authenticated;

-- Games: everyone can read
CREATE POLICY "games_read" ON games FOR SELECT USING (true);
CREATE POLICY "games_insert" ON games FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "games_update" ON games FOR UPDATE USING (true);

-- Countries: everyone can read
CREATE POLICY "countries_read" ON countries FOR SELECT USING (true);
CREATE POLICY "countries_insert" ON countries FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "countries_update" ON countries FOR UPDATE USING (
  player_id = auth.uid() OR true  -- relaxed for game mechanics; tighten with edge functions in prod
);

-- Pixels: everyone can read, authenticated can write
CREATE POLICY "pixels_read" ON pixels FOR SELECT USING (true);
CREATE POLICY "pixels_write" ON pixels FOR ALL USING (auth.uid() IS NOT NULL);

-- Attacks, trades, infra, events, messages
CREATE POLICY "attacks_read" ON attacks FOR SELECT USING (true);
CREATE POLICY "attacks_insert" ON attacks FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "trades_all" ON trades FOR ALL USING (true);
CREATE POLICY "infra_all" ON infrastructure FOR ALL USING (true);
CREATE POLICY "events_read" ON game_events FOR SELECT USING (true);
CREATE POLICY "events_insert" ON game_events FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "messages_all" ON messages FOR ALL USING (true);

-- ============================================================
-- REALTIME
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE pixels;
ALTER PUBLICATION supabase_realtime ADD TABLE game_events;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE countries;
ALTER PUBLICATION supabase_realtime ADD TABLE attacks;
ALTER PUBLICATION supabase_realtime ADD TABLE trades;

-- ============================================================
-- INITIAL WORLDS (small / medium / big)
-- These are the 3 always-available worlds players can join.
-- When one fills up, the app automatically opens a new world
-- in the same category.
-- ============================================================
INSERT INTO games (code, name, category, is_open, map_width, map_height, max_players, status) VALUES
  ('PR-SM01', 'Small Realm #1',  'small',  TRUE, 60,  50,  20, 'waiting'),
  ('PR-MD01', 'Medium Realm #1', 'medium', TRUE, 100, 80,  35, 'waiting'),
  ('PR-BG01', 'Grand Realm #1',  'big',    TRUE, 150, 120, 50, 'waiting');
