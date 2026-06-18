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
  BASE_INCOME_PER_PIXEL: 2,          // base gold per pixel per hour
  STARTING_ARMY: 5,                  // army units at nation creation
  BORDER_UPKEEP_PER_NATION: 2,       // gold/hr upkeep per border pixel (pixel of yours touching an enemy pixel)
  POPULATION_PER_PIXEL: 20,          // people per pixel owned
  BARRACKS_POPULATION_COST: 100,     // population required per barracks
  FOOD_PRODUCTION_PER_PIXEL: 0.25,   // base food/hr per pixel (foraging)
  FOOD_PRODUCTION_PER_FARM: 5,       // food/hr per farm building
  FOOD_CONSUMPTION_PER_PIXEL: 0.1,   // base food/hr per pixel (low — army drives the rest)
  FOOD_CONSUMPTION_PER_ARMY: 0.1,    // food/hr per army unit — wars/barracks increase food need
  FOOD_AGGRESSION_PER_ATTACK: 0.05,  // added to per-pixel food rate per attack (win or loss)
  FOOD_AGGRESSION_DECAY: 0.02,       // per-pixel rate decrease per real hour (back to base 0.1)
  // Terrain multipliers for mine flat income (pixel bonus unaffected)
  MINE_TERRAIN_MULT: { mountain: 1.8, hill: 1.3, grass: 0.9, desert: 0.5, water: 0 },
  // Terrain multipliers for farm income
  FARM_TERRAIN_MULT: { grass: 1.5, hill: 1.0, mountain: 0.5, desert: 0.3, water: 0 },
  PIXEL_SIZE: 8,                  // px per map tile
  INCOME_TICK_SECONDS: 10,        // how often gold income is applied
  PIXELS_PER_HOUR: 1,             // expansion tokens per hour offline
  MAX_STACK: 24,                  // max stacked expansion tokens
  STARTING_PIXELS: 5,             // pixels at country creation
  STARTING_GOLD: 100,
  STARTING_EXPANSION_TOKENS: 3,   // expansion tokens available immediately
  ARMY_PER_PIXEL: 2,              // army units per pixel at start
  ATTACK_GOLD_COST: 0,
  ARMY_UPKEEP_PER_UNIT: 0.25,      // gold/hr per army unit (scales with barracks)
  BARRACKS_REGEN_PER_HOUR: 0.5,    // army units regenerated per hour per barracks built
  INFRA_COSTS: {
    farm:     { gold: 80,  effect: '+0.05 gold/pixel/hr income, nation-wide',      incomeBonus: 0.05 },
    mine:     { gold: 80,  effect: '+10 gold/hr flat + 0.02 gold/pixel/hr hybrid income', flatIncome: 10, pixelBonus: 0.02 },
    market:   { gold: 100, effect: '-0.03 territory upkeep per pixel, nation-wide', upkeepReduction: 0.03 },
    barracks: { gold: 150, effect: '+20 army instantly · regenerates 0.5 army/hr per barracks up to cap', armyBonus: 20 },
    wall:     { gold: 60,  effect: '+50% defense when this tile is attacked',      defenseBonus: 0.5 },
    trading_post: { gold: 90,  effect: '+1g/hr flat + 2g/hr per neighboring nation (terrain-adjusted)', flatIncome: 1, incomePerNation: 2 },
  },
  TRADING_POST_TERRAIN_MULT: { desert: 1.5, hill: 1.1, grass: 0.9, mountain: 0.5, water: 0 },
  TOKEN_BUY_COST: 1000,            // gold cost to buy 1 expansion token
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
