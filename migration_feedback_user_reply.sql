-- Add user_reply column so players can respond to admin replies
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS user_reply TEXT;

-- Allow users to update their own feedback row (for user_reply)
CREATE POLICY "Users can update own feedback" ON public.feedback
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
