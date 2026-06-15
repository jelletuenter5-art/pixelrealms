-- PixelRealms — Full wipe (testing complete, going live)
-- Run this in your Supabase SQL editor.
--
-- WARNING: this permanently deletes EVERYTHING — every world, country,
-- pixel, message, trade, feedback entry, AND every user account
-- (including yours). There is no undo. Only run this once you're ready
-- for a totally clean slate.

-- 1. Wipe all games and everything tied to them (countries, pixels,
--    infrastructure, messages, game_events, attacks, trades — all cascade)
DELETE FROM games;

-- 2. Delete every account. Cascades to profiles and feedback.
DELETE FROM auth.users;

-- ============================================================
-- AFTER RUNNING THIS:
--   1. Go to the live site and register a brand new account with
--      whatever username/password you want (signup only needs a
--      username + password — an internal placeholder email is
--      generated automatically, you never see/use it).
--   2. Find the id of the account you just created:
--
--      SELECT id, username, created_at FROM profiles ORDER BY created_at DESC LIMIT 1;
--
--   3. Grant admin to that specific account by its id:
--
--      UPDATE profiles SET is_admin = true WHERE id = 'paste-the-id-here';
--
--      This ties the admin flag to that specific account row (its
--      UUID), not just the username — so if this account is ever
--      deleted and someone else later registers the same username,
--      they will NOT inherit admin.
-- ============================================================
