-- PixelRealms — Fix missing table grants
-- Run this in your Supabase SQL editor.
--
-- RLS policies were in place, but the underlying GRANT privileges on
-- the tables were missing, causing "permission denied for table X"
-- (error 42501) on every request.

GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.profiles,
  public.games,
  public.countries,
  public.pixels,
  public.attacks,
  public.trades,
  public.infrastructure,
  public.game_events,
  public.messages
TO anon, authenticated;

GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
