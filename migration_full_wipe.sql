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
--   1. Go to the live site and register a brand new account
--      (pick whatever username/password you want).
--   2. Run the query below, replacing the email with the one you
--      just signed up with, to make that account an admin.
--
--      This ties the admin flag to YOUR specific account (via the
--      email/password you registered with), not just a username —
--      so if your account is ever deleted and someone else later
--      registers the same username, they will NOT inherit admin.
-- ============================================================

-- UPDATE profiles SET is_admin = true
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'your-signup-email@example.com');
