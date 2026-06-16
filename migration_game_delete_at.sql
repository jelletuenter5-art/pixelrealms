-- PixelRealms — Add delete_at column to games for 48h post-win cleanup
-- Run in Supabase SQL Editor.

ALTER TABLE games ADD COLUMN IF NOT EXISTS delete_at TIMESTAMPTZ;
