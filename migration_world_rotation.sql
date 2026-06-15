-- PixelRealms — World Rotation Migration
-- Run this in your Supabase SQL editor if you already have a `games` table
-- (i.e. you ran schema.sql before this feature existed).
--
-- This switches the lobby from "create your own game" to a fixed set of
-- 3 always-on worlds (small / medium / big). When a world fills up, the
-- app automatically opens the next world in that category.

ALTER TABLE games ADD COLUMN IF NOT EXISTS category TEXT CHECK (category IN ('small','medium','big'));
ALTER TABLE games ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT FALSE;

-- Only one open (joinable) world per category at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_open_category ON games(category) WHERE is_open = TRUE;

-- Seed the 3 initial worlds if they don't already exist
INSERT INTO games (code, name, category, is_open, map_width, map_height, max_players, status)
SELECT 'PR-SM01', 'Small Realm #1', 'small', TRUE, 60, 50, 20, 'waiting'
WHERE NOT EXISTS (SELECT 1 FROM games WHERE category = 'small' AND is_open = TRUE);

INSERT INTO games (code, name, category, is_open, map_width, map_height, max_players, status)
SELECT 'PR-MD01', 'Medium Realm #1', 'medium', TRUE, 100, 80, 35, 'waiting'
WHERE NOT EXISTS (SELECT 1 FROM games WHERE category = 'medium' AND is_open = TRUE);

INSERT INTO games (code, name, category, is_open, map_width, map_height, max_players, status)
SELECT 'PR-BG01', 'Grand Realm #1', 'big', TRUE, 150, 120, 50, 'waiting'
WHERE NOT EXISTS (SELECT 1 FROM games WHERE category = 'big' AND is_open = TRUE);
