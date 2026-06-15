// PixelRealms — config.js
// Replace these with your actual Supabase credentials after setup

const SUPABASE_URL = 'https://lezdjsrkiczasrdpfuqs.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxlemRqc3JraWN6YXNyZHBmdXFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MTYxNjIsImV4cCI6MjA5NzA5MjE2Mn0.2KcHVYCr4Nj2eUIYRSZq0FiK4f0r6dzz8BArx3ZCnwE';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// GAME CONSTANTS
// ============================================================
const CONFIG = {
  PIXEL_SIZE: 8,                  // px per map tile
  PIXELS_PER_HOUR: 1,             // expansion tokens per hour offline
  MAX_STACK: 24,                  // max stacked expansion tokens
  STARTING_PIXELS: 5,             // pixels at country creation
  STARTING_GOLD: 100,
  STARTING_EXPANSION_TOKENS: 3,   // expansion tokens available immediately
  ARMY_PER_PIXEL: 2,              // army units per pixel at start
  ATTACK_GOLD_COST: 10,
  INFRA_COSTS: {
    farm:     { gold: 50,  effect: 'Doubles income for 5 pixels',  incomeBonus: 0.5 },
    barracks: { gold: 80,  effect: '+20 army units',               armyBonus: 20 },
    market:   { gold: 60,  effect: '+0.3 gold/pixel/hr trade bonus',tradeBonus: 0.3 },
    wall:     { gold: 40,  effect: '+50% defense on this tile',    defenseBonus: 0.5 },
    mine:     { gold: 70,  effect: '+10 gold/hr flat income',      flatIncome: 10 },
  },
  TERRAIN_DEFENSE: {
    grass: 1.0, hill: 1.3, mountain: 1.6, desert: 0.8, water: 0
  },
  TERRAIN_INCOME: {
    grass: 1.0, hill: 0.8, mountain: 0.6, desert: 0.7, water: 0
  },
  MAP_WIDTH: 100,
  MAP_HEIGHT: 80,
  COUNTRY_COLORS: [
    '#ef4444','#f97316','#eab308','#22c55e','#06b6d4',
    '#8b5cf6','#ec4899','#14b8a6','#f43f5e','#84cc16',
    '#0ea5e9','#a855f7','#fb923c','#4ade80','#38bdf8',
    '#c084fc','#fb7185','#a3e635','#34d399','#fbbf24',
  ],
};
