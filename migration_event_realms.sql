-- Add is_admin_created flag to games table
-- Admin-created event realms are never auto-deleted and don't get replaced on win
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS is_admin_created BOOLEAN DEFAULT false;

-- Allow admins to insert new games (needed for createEventRealm)
-- This assumes RLS is enabled on games table. Adjust policy if needed.
-- If you already have an admin insert policy, skip this.
CREATE POLICY "Admins can insert games" ON public.games
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- Allow admins to delete games (for deleteEventRealm)
CREATE POLICY "Admins can delete games" ON public.games
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
