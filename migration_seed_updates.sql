-- PixelRealms — Seed the game_updates table with the v1.3 changelog
-- Run this AFTER migration_updates.sql, while logged in as your admin account.
-- (Or just post it via the Admin → Post Update form in the lobby.)

INSERT INTO game_updates (version, content) VALUES (
  'v1.3 — Major Update',
  '⚔️ Combat
• Attacks are now FREE — no gold cost, only manpower
• New attack preview: see terrain defense, wall bonus, and estimated outcome before you commit

🏗️ Balance
• Mines reworked: cost 50g (was 70g), income +15 gold/hr (was +5/hr) — strong at any nation size

🔔 Notifications
• Red dot on Chat tab when new messages arrive while you''re elsewhere
• Red dot on Feedback tab when an admin replies to your message
• Red dot on Updates tab when new updates are posted
• Red dot on Admin tab when new player feedback arrives (admins only)

💀 Eliminated Players
• Seeing a "You Were Eliminated" screen when you lose, with option to start fresh in the same world

📦 Archive System
• Archive games from My Realms — moves them to the Archived tab
• Games auto-archived when you''re eliminated and inactive for 3+ days

📋 Updates Tab
• This tab! All game changes posted here with version codes

🌍 World Rotation
• A fresh world automatically opens when a game ends (one nation conquers all)

📊 Leaderboard
• Games column now shows total games played (active + finished)

⚙️ Quality of Life
• Chat shows account name + (Country Name) for each message
• Flag emoji picker in join modal — tap to select, no copy-paste needed
• Mobile lobby tabs now visible in a grid — no horizontal scrolling
• Spawn bug fixed — can no longer accidentally place spawn twice
• Clicking your own tile in Expand mode no longer wastes a token
• Build confirmation modal now appears above the panel drawer on phone
• Inactive nations (3+ days offline) noted in the Events tab'
);
