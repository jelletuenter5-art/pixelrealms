-- PixelRealms — Full reset
-- Run this in your Supabase SQL editor.
--
-- Wipes ALL game/world data (games cascades to pixels, countries,
-- infrastructure, messages, game_events, attacks, trades) and removes
-- every account except the one with username 'JelleT'.
--
-- WARNING: this permanently deletes other players' accounts (auth.users),
-- which cascades to their profiles and feedback. Make sure this is
-- really what you want before running it.

-- 1. Wipe all games and everything tied to them
DELETE FROM games;

-- 2. Reset JelleT's lifetime stats
UPDATE profiles
SET total_wins = 0, total_pixels_ever = 0, games_played = 0
WHERE username = 'JelleT';

-- 3. Delete every other account (cascades to profiles + feedback)
DELETE FROM auth.users
WHERE id <> (SELECT id FROM profiles WHERE username = 'JelleT');
