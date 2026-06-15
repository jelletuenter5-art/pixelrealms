-- PixelRealms — Full Reset + Admin Account Setup
-- Run this in your Supabase SQL editor.
--
-- WARNING: This permanently deletes ALL existing players, games,
-- countries, pixels, and progress. Use only for a clean restart.

-- ============================================================
-- STEP 1: Wipe all game data
-- ============================================================
TRUNCATE TABLE
  messages,
  game_events,
  infrastructure,
  trades,
  attacks,
  pixels,
  countries,
  games
RESTART IDENTITY CASCADE;

-- Re-seed the 3 starting worlds
INSERT INTO games (code, name, category, is_open, map_width, map_height, max_players, status) VALUES
  ('PR-SM01', 'Small Realm #1',  'small',  TRUE, 60,  50,  20, 'waiting'),
  ('PR-MD01', 'Medium Realm #1', 'medium', TRUE, 100, 80,  35, 'waiting'),
  ('PR-BG01', 'Grand Realm #1',  'big',    TRUE, 150, 120, 50, 'waiting');

-- ============================================================
-- STEP 2: Add admin flag to profiles
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- ============================================================
-- STEP 3: Delete all existing user accounts
-- ============================================================
-- Go to Supabase Dashboard → Authentication → Users, select all
-- users, and delete them. This automatically cascades and removes
-- their `profiles` rows too (FK ON DELETE CASCADE).
--
-- After that:
--   1. Register a new account on the site with username "JelleT"
--      and password "!PR05jt".
--   2. Come back here and run STEP 4 below.

-- ============================================================
-- STEP 4: Promote JelleT to admin (run AFTER registering)
-- ============================================================
-- UPDATE profiles SET is_admin = true WHERE username = 'JelleT';
