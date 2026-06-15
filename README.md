# PixelRealms 🗺️⚔️

A real-time multiplayer pixel strategy game. Build a nation, expand territory, attack enemies, trade resources, and conquer the world — one pixel at a time.

---

## Files

```
pixelrealms/
├── schema.sql              ← Run this in Supabase SQL editor FIRST
├── js/
│   ├── config.js           ← ⚠️ Add your Supabase credentials here
│   ├── mapgen.js           ← Procedural terrain generation engine
│   └── game.js             ← Core game mechanics (combat, expansion, trade)
└── pages/
    ├── index.html          ← Login / Register page
    ├── lobby.html          ← Game browser, create game, leaderboard
    └── game.html           ← The live game map & all interactions
```

---

## Setup

### 1. Create a Supabase Project
Go to [supabase.com](https://supabase.com) → New Project → pick a name and password.

### 2. Run the Schema
- In your Supabase dashboard → **SQL Editor**
- Paste the entire contents of `schema.sql` and click **Run**
- This creates all tables, indexes, RLS policies, and realtime subscriptions

### 3. Add Your Credentials
Open `js/config.js` and replace:
```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';       // Settings → API → Project URL
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // Settings → API → anon public key
```

### 4. Serve the Files
You need to serve these over HTTP (not open as files). Options:

**Option A — VS Code Live Server:** Right-click `index.html` → Open with Live Server

**Option B — Python:**
```bash
cd pixelrealms
python3 -m http.server 3000
# Open http://localhost:3000/pages/index.html
```

**Option C — Deploy to Netlify/Vercel:** Drag the `pixelrealms` folder into Netlify Drop

---

## How to Play

### Getting Started
1. Create an account on the login page
2. Join or create a game (share the 6-char code with friends)
3. Name your country and pick a color
4. You start with 5 pixels on the map

### Core Loop
| Mechanic | Detail |
|---|---|
| **Expand** | Spend expansion tokens to claim adjacent empty tiles |
| **Attack** | Spend 10 gold to attack an adjacent enemy tile — success depends on army strength and terrain defense |
| **Build** | Construct infrastructure on your tiles to boost income, army, or defense |
| **Trade** | Send gold to other nations to form alliances |

### Expansion Tokens
- You earn **1 token per hour** (even offline)
- Tokens stack up to **24 max** (1 day's worth)
- Log in regularly to not waste potential expansion time

### Income System
- Each pixel earns you **0.5 gold/hr** base
- Hills and mountains earn **less** than grassland
- **Farms** boost income per pixel
- **Mines** give flat hourly income
- **Army upkeep** drains gold based on territory size

### Combat
```
Attack Power = your army × random(0.8–1.2)
Defense Power = enemy army × terrain multiplier × random(0.8–1.2)

Terrain defense multipliers:
  Grass    ×1.0    Desert ×0.8
  Hill     ×1.3    Water  ×0 (can't be attacked/expanded into)
  Mountain ×1.6
```

### Buildings
| Building | Cost | Effect |
|---|---|---|
| 🌾 Farm | 50g | +0.5 income/pixel |
| ⚔️ Barracks | 80g | +20 army units |
| 🏪 Market | 60g | +0.3 trade gold/hr |
| 🧱 Wall | 40g | +50% tile defense |
| ⛏️ Mine | 70g | +10 gold/hr flat |

### Leaderboard Metrics
- **Total Wins** — games where your nation survived to the end
- **Total Pixels Ever** — all-time pixels claimed across all games
- **Games Played** — your experience level

---

## Game Tips
- Don't over-expand — large territory means high army upkeep
- Build Barracks before attacking experienced players
- Mountains are great defensive positions
- Keep at least 20 gold in reserve for emergencies
- Form trade alliances early for income advantages
- Log in daily to stack expansion tokens

---

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Database:** Supabase (PostgreSQL)
- **Realtime:** Supabase Realtime (websockets)
- **Auth:** Supabase Auth (email/password)
- **Map:** Custom seeded procedural noise (no external libs)
- **Hosting:** Any static file host
