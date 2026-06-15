-- PixelRealms — Smooth gold income
-- Run this in your Supabase SQL editor.
--
-- Gold now accrues in small fractional amounts every few seconds instead of
-- whole numbers once an hour, so it needs to be a float column.

ALTER TABLE countries ALTER COLUMN gold TYPE FLOAT;
