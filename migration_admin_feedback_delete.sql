-- PixelRealms — Allow admins to delete feedback rows
-- Run in Supabase SQL Editor.

CREATE POLICY "Admins can delete feedback"
  ON feedback FOR DELETE
  USING ((SELECT is_admin FROM profiles WHERE id = auth.uid()) = true);

-- Also allow admins to update game_updates (for edit functionality)
CREATE POLICY "Admins can update game_updates"
  ON game_updates FOR UPDATE
  USING ((SELECT is_admin FROM profiles WHERE id = auth.uid()) = true)
  WITH CHECK ((SELECT is_admin FROM profiles WHERE id = auth.uid()) = true);
