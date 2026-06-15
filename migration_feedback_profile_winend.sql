-- PixelRealms — Feedback system, profile customization, game cleanup support
-- Run this in your Supabase SQL editor.

-- ============================================================
-- PROFILE CUSTOMIZATION (avatar emoji for leaderboard / settings)
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_emoji TEXT DEFAULT '🙂';

-- ============================================================
-- FEEDBACK
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved')),
  admin_reply TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "feedback_read" ON feedback;
CREATE POLICY "feedback_read" ON feedback FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

DROP POLICY IF EXISTS "feedback_insert" ON feedback;
CREATE POLICY "feedback_insert" ON feedback FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "feedback_update" ON feedback;
CREATE POLICY "feedback_update" ON feedback FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true)
);

GRANT SELECT, INSERT, UPDATE ON feedback TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE feedback;
