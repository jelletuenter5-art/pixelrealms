-- Threaded feedback messages table
CREATE TABLE IF NOT EXISTS public.feedback_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL REFERENCES public.feedback(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'admin')),
  user_id UUID REFERENCES auth.users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.feedback_messages ENABLE ROW LEVEL SECURITY;

-- Users can read messages on their own feedback tickets
CREATE POLICY "Users read own feedback messages" ON public.feedback_messages
  FOR SELECT TO authenticated
  USING (
    feedback_id IN (SELECT id FROM public.feedback WHERE user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- Users can insert messages on their own tickets (sender = 'user')
CREATE POLICY "Users insert own feedback messages" ON public.feedback_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender = 'user' AND user_id = auth.uid()
    AND feedback_id IN (SELECT id FROM public.feedback WHERE user_id = auth.uid())
  );

-- Admins can insert any message
CREATE POLICY "Admins insert feedback messages" ON public.feedback_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

GRANT SELECT, INSERT ON public.feedback_messages TO authenticated;
