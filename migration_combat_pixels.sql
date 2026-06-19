-- Add combat pixel tracking columns to countries table
ALTER TABLE public.countries
  ADD COLUMN IF NOT EXISTS pixels_captured INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pixels_lost INTEGER NOT NULL DEFAULT 0;
