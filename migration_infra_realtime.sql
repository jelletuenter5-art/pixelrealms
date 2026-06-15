-- PixelRealms — Add infrastructure to realtime publication
-- Run this in your Supabase SQL editor.
--
-- Lets all players see buildings appear on the map live as they're built.

ALTER PUBLICATION supabase_realtime ADD TABLE infrastructure;
