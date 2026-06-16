-- PixelRealms — Fix permissions for game_updates table
-- Run this in Supabase SQL Editor (as postgres/service role).
-- Tables created via SQL Editor don't auto-grant to anon/authenticated.

GRANT SELECT ON public.game_updates TO anon, authenticated;
GRANT INSERT, DELETE ON public.game_updates TO authenticated;
