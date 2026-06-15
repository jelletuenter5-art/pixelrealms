-- PixelRealms — Auto-create Profile on Signup
-- Run this in your Supabase SQL editor.
--
-- Fixes registration so a `profiles` row is always created for new
-- users, even when email confirmation is required (the client-side
-- insert used to be blocked by RLS in that case).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'username');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- Fix existing accounts that registered before this trigger existed
-- and ended up with no profile row (e.g. JelleT).
-- Adjust the username below if needed.
-- ============================================================
INSERT INTO public.profiles (id, username, is_admin)
SELECT au.id, 'JelleT', true
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL;
