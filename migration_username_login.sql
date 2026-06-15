-- PixelRealms — Username Login Migration
-- Run this in your Supabase SQL editor.
--
-- Adds a function that lets the login page look up a user's email
-- by their username, so players can sign in with just
-- username + password (registration still collects email).

CREATE OR REPLACE FUNCTION get_email_for_username(input_username TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT au.email
  FROM auth.users au
  JOIN public.profiles p ON p.id = au.id
  WHERE p.username = input_username
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_email_for_username(TEXT) TO anon, authenticated;
