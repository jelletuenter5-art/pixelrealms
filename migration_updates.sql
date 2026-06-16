-- PixelRealms — Add game_updates table for the Updates tab / changelog
-- Run this in your Supabase SQL editor before using the Updates tab.

CREATE TABLE IF NOT EXISTS game_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  version TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE game_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view game_updates"
  ON game_updates FOR SELECT USING (true);

CREATE POLICY "Admins can insert game_updates"
  ON game_updates FOR INSERT
  WITH CHECK ((SELECT is_admin FROM profiles WHERE id = auth.uid()) = true);

CREATE POLICY "Admins can delete game_updates"
  ON game_updates FOR DELETE
  USING ((SELECT is_admin FROM profiles WHERE id = auth.uid()) = true);
