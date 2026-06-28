// PixelRealms — game.js
// Core game mechanics: expansion, combat, income, infrastructure

class GameEngine {
  constructor(gameId, playerId) {
    this.gameId = gameId;
    this.playerId = playerId;
    this.country = null;
    this.game = null;
    this.map = null;       // local rendered map grid
    this.pixelData = {};   // key: "x,y" -> pixel record
    this.countries = {};   // id -> country
    this.realtimeSubs = [];
  }

  // ── Bootstrap ────────────────────────────────────────────
  // Pixels table can hold many thousands of rows per game (e.g. 150x120),
  // far beyond Supabase's default 1000-row response limit — page through
  // all of them so the full map and territory state load correctly.
  async _fetchAllPixels() {
    const pageSize = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb.from('pixels').select('*')
        .eq('game_id', this.gameId).range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  async _fetchAllInfra() {
    const pageSize = 1000;
    let all = [], from = 0;
    while (true) {
      const { data, error } = await sb.from('infrastructure').select('*')
        .eq('game_id', this.gameId).range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  async load() {
    const [gameRes, countryRes, pixels, countriesRes, infraRows] = await Promise.all([
      sb.from('games').select('*').eq('id', this.gameId).single(),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('player_id', this.playerId).single(),
      this._fetchAllPixels(),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('is_alive', true),
      this._fetchAllInfra(),
    ]);

    this.game = gameRes.data;
    this.speed = this.game?.speed_multiplier || 1;
    this.country = countryRes.data;

    // Index pixel data
    pixels.forEach(p => {
      this.pixelData[`${p.x},${p.y}`] = p;
    });

    // Index countries
    (countriesRes.data || []).forEach(c => {
      this.countries[c.id] = c;
    });

    // Index infrastructure — walls (fortifications) stored separately so a tile
    // can have both a regular building and a fortification simultaneously
    this.infraData = {};
    this.wallData = {};
    console.log('[PixelRealms] infra load — rows:', infraRows.length);
    infraRows.forEach(i => {
      if (i.type === 'wall') this.wallData[`${i.pixel_x},${i.pixel_y}`] = i;
      else this.infraData[`${i.pixel_x},${i.pixel_y}`] = i;
    });

    // Calculate pending pixels from time offline
    if (this.country) {
      await this.accruePendingPixels();
      await this._reconcileCountryStats();
      await this._enforceMarketCap();
    }

    // Fix all other countries whose pixel_count is out of sync with the actual map.
    // This catches ghosts (0px but still alive) and desync from mid-session crashes.
    await this._reconcileAllCountries();

    await this.loadBoats();

    console.log('%c⛵ PixelRealms — Run this SQL in Supabase if boats table is missing:', 'color:#f59e0b;font-weight:bold');
    console.log(`create table if not exists boats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  country_id uuid references countries(id) on delete cascade,
  from_harbor_id uuid references infrastructure(id) on delete set null,
  to_x integer not null,
  to_y integer not null,
  mode text not null check (mode in ('expand','attack')),
  path jsonb not null default '[]',
  current_step integer default 0,
  status text not null default 'sailing' check (status in ('sailing','arrived','failed','cancelled')),
  created_at timestamptz default now(),
  arrives_at timestamptz
);
alter table boats enable row level security;
create policy "read boats" on boats for select using (true);
create policy "insert boats" on boats for insert with check (true);
create policy "update boats" on boats for update using (true);`);

    return this;
  }

  // Recompute pixel_count / income / upkeep from real territory + buildings so
  // stored counters can't drift out of sync with the actual map state.
  async _reconcileCountryStats() {
    const myPixels = Object.values(this.pixelData).filter(p => p.country_id === this.country.id);
    const myInfra = Object.values(this.infraData).filter(i => i.country_id === this.country.id);
    const farms = myInfra.filter(i => i.type === 'farm').length;
    const markets = myInfra.filter(i => i.type === 'market').length;

    const correctPixelCount = myPixels.length;
    const correctIncome = CONFIG.BASE_INCOME_PER_PIXEL; // farms computed dynamically from terrain
    const correctUpkeep = Math.max(0.02, calcTierUpkeepRate(correctPixelCount) - markets * CONFIG.INFRA_COSTS.market.upkeepReduction);

    const updates = {};
    // Correct pixel_count if actual pixels differ — also handles the case where
    // a player lost all pixels but pixel_count was never zeroed (e.g. water-spawn edge case)
    if (correctPixelCount !== this.country.pixel_count) updates.pixel_count = correctPixelCount;
    // Only eliminate if they LOST pixels (had some before) — not if they haven't spawned yet
    // (pixel_count === 0 with no pixels means they're in spawn selection, not eliminated)
    if (correctPixelCount === 0 && this.country.pixel_count > 0 && this.country.is_alive) {
      updates.is_alive = false;
      updates.surrendered_at = new Date().toISOString();
    }
    if (Math.abs(correctIncome - this.country.income_per_pixel) > 1e-6) updates.income_per_pixel = correctIncome;
    if (Math.abs(correctUpkeep - this.country.army_upkeep_per_pixel) > 1e-6) updates.army_upkeep_per_pixel = correctUpkeep;
    // Repair gold only if it's null or NaN — never reset negative gold
    if (this.country.gold == null || isNaN(this.country.gold)) {
      updates.gold = 0;
    }

    if (Object.keys(updates).length > 0) {
      const { data } = await sb.from('countries').update(updates).eq('id', this.country.id).select().single();
      if (data) this.country = data;
    }

  }

  // Fix pixel_count and is_alive for ALL countries based on actual pixel data.
  // Runs once on load — fixes ghost countries and desync without needing a server trigger.
  async _reconcileAllCountries() {
    // Count actual owned pixels per country from the already-loaded pixelData
    const actualCount = {};
    for (const p of Object.values(this.pixelData)) {
      if (p.country_id) actualCount[p.country_id] = (actualCount[p.country_id] || 0) + 1;
    }
    const now = new Date().toISOString();
    for (const country of Object.values(this.countries)) {
      if (country.id === this.country?.id) continue; // own country handled by _reconcileCountryStats
      const actual = actualCount[country.id] || 0;
      const updates = {};
      if (actual !== country.pixel_count) updates.pixel_count = actual;
      // Eliminate if 0 actual pixels and still alive, provided they're not a brand-new
      // player in spawn selection (give 30 min grace period for new spawns)
      const ageMinutes = (Date.now() - new Date(country.created_at).getTime()) / 60000;
      if (actual === 0 && country.is_alive && (country.pixel_count > 0 || ageMinutes > 30)) {
        updates.is_alive = false;
        updates.surrendered_at = now;
      }
      if (Object.keys(updates).length > 0) {
        await sb.from('countries').update(updates).eq('id', country.id);
        this.countries[country.id] = { ...country, ...updates };
      }

    }
  }

  // ── Market Cap Enforcement ────────────────────────────────
  async _enforceMarketCap() {
    const max = CONFIG.INFRA_COSTS.market.maxCount;
    const myMarkets = Object.values(this.infraData)
      .filter(i => i.country_id === this.country.id && i.type === 'market');
    if (myMarkets.length <= max) return;

    // Shuffle and delete the excess randomly
    const shuffled = myMarkets.sort(() => Math.random() - 0.5);
    const toDelete = shuffled.slice(max);
    for (const m of toDelete) {
      await sb.from('infrastructure').delete().eq('id', m.id);
      delete this.infraData[`${m.pixel_x},${m.pixel_y}`];
    }
    // Recompute upkeep based on remaining markets
    const remaining = myMarkets.length - toDelete.length;
    const newUpkeep = Math.max(0.02, 0.3 - remaining * CONFIG.INFRA_COSTS.market.upkeepReduction);
    await sb.from('countries').update({ army_upkeep_per_pixel: newUpkeep }).eq('id', this.country.id);
    this.country.army_upkeep_per_pixel = newUpkeep;
  }

  // ── Pixel Accrual (offline expansion tokens) ─────────────
  async accruePendingPixels() {
    const now = new Date();

    // Guard null last_active (country just created, never been active)
    if (!this.country.last_active) {
      await sb.from('countries').update({ last_active: now.toISOString() }).eq('id', this.country.id);
      this.country.last_active = now.toISOString();
      return;
    }

    const last = new Date(this.country.last_active);
    // Cap at 48h so invalid timestamps don't give massive gold windfalls
    const hoursOffline = Math.min((now - last) / 3600000, 48);

    if (hoursOffline < 0.05) return; // < 3 min, skip

    const speed = this.speed || 1;
    const newTokens = Math.min(
      this.country.pending_pixels + hoursOffline * CONFIG.PIXELS_PER_HOUR * speed,
      CONFIG.MAX_STACK
    );

    // Compute offline accruals for gold, food, army, and aggression decay
    const myInfra = Object.values(this.infraData || {}).filter(i => i.country_id === this.country.id);
    const mineInfra = myInfra.filter(i => i.type === 'mine');
    const farmInfra = myInfra.filter(i => i.type === 'farm');
    const tradingPostInfra = myInfra.filter(i => i.type === 'trading_post');
    const barracksCount = myInfra.filter(i => i.type === 'barracks').length;

    const incomePerPx = this.country.income_per_pixel || CONFIG.BASE_INCOME_PER_PIXEL;
    const markets = myInfra.filter(i => i.type === 'market').length;
    const upkeepPerPx = Math.max(0.02, calcTierUpkeepRate(this.country.pixel_count) - markets * CONFIG.INFRA_COSTS.market.upkeepReduction);
    const baseIncome = incomePerPx * this.country.pixel_count;
    const mineIncome = calcMineIncome(mineInfra, this.country.pixel_count, this.pixelData);
    const farmIncome = calcFarmIncome(farmInfra, this.country.pixel_count, this.pixelData);
    const border = calcBorderUpkeep(this.pixelData, this.country.id, this.country.pixel_count);
    const tradingPostIncome = calcTradingPostIncome(tradingPostInfra, this.pixelData, border.nations);
    const currentAggression = Number.isFinite(this.country.food_aggression) ? this.country.food_aggression : 0;
    const foodBalance = calcFoodBalance(farmInfra, this.country.pixel_count, this.country.army_size, currentAggression);
    const foodThreshold = this.country.pixel_count * CONFIG.POPULATION_PER_PIXEL * 0.5;
    const currentFood = Number.isFinite(this.country.food) ? this.country.food : 0;
    const foodMult = (foodThreshold > 0 && currentFood < foodThreshold)
      ? Math.max(0.2, currentFood / foodThreshold)
      : 1;
    const hourlyIncome = (baseIncome + mineIncome + farmIncome + tradingPostIncome) * foodMult;
    const pixelUpkeep = Math.max(0, upkeepPerPx * this.country.pixel_count);
    const armyUpkeep = this.country.army_size * CONFIG.ARMY_UPKEEP_PER_UNIT;
    const harborCount = myInfra.filter(i => i.type === 'harbor').length;
    const harborUpkeep = harborCount * CONFIG.INFRA_COSTS.harbor.upkeepPerHour;
    // Border upkeep capped at gross income — being surrounded can't create an inescapable spiral
    const borderCost = Math.min(border.cost, hourlyIncome);
    const currentGold = Number.isFinite(this.country.gold) ? this.country.gold : 0;
    const scaledHours = hoursOffline * speed;
    const newGold = Math.max(0, Math.round((currentGold + (hourlyIncome - pixelUpkeep - armyUpkeep - borderCost - harborUpkeep) * scaledHours) * 10000) / 10000);

    // Food offline — capped at FOOD_CAP_PER_PIXEL per pixel
    const foodCap = this.country.pixel_count * CONFIG.FOOD_CAP_PER_PIXEL;
    const newFood = Math.min(foodCap, Math.max(0, Math.round((currentFood + foodBalance * scaledHours) * 100) / 100));

    // Army regen offline — barracks regenerate up to their cap; drain slowly if over cap
    const armyCap = barracksCount * CONFIG.INFRA_COSTS.barracks.armyBonus;
    const currentArmy = this.country.army_size || 0;
    let newArmy;
    if (barracksCount > 0 && currentArmy < armyCap) {
      newArmy = Math.min(armyCap, Math.floor(currentArmy + barracksCount * CONFIG.BARRACKS_REGEN_PER_HOUR * scaledHours));
    } else if (currentArmy > armyCap) {
      // Drain at same regen rate until at cap
      newArmy = Math.max(armyCap, Math.floor(currentArmy - barracksCount * CONFIG.BARRACKS_REGEN_PER_HOUR * scaledHours));
    } else {
      newArmy = currentArmy;
    }

    // Food aggression decays offline — boosted by markets
    const marketsCount = myInfra.filter(i => i.type === 'market').length;
    const effectiveDecay = CONFIG.FOOD_AGGRESSION_DECAY + marketsCount * CONFIG.MARKET_DECAY_BONUS;
    const newAggression = Math.max(0, Math.round((currentAggression - effectiveDecay * scaledHours) * 100000) / 100000);

    const updates = {
      pending_pixels: newTokens,
      gold: newGold,
      food: newFood,
      army_size: newArmy,
      food_aggression: newAggression,
      last_active: now.toISOString(),
    };
    const { data } = await sb.from('countries').update(updates).eq('id', this.country.id).select().single();
    if (data) this.country = data;
  }

  // How many whole expansion tokens available
  get expansionTokens() {
    return this.country ? Math.floor(this.country.pending_pixels) : 0;
  }

  // Live-interpolated pending tokens (accrue visually between server syncs)
  getLivePending() {
    if (!this.country) return 0;
    const last = new Date(this.country.last_active);
    const hoursElapsed = Math.max(0, (Date.now() - last) / 3600000);
    const speed = this.speed || 1;
    return Math.min(this.country.pending_pixels + hoursElapsed * CONFIG.PIXELS_PER_HOUR * speed, CONFIG.MAX_STACK);
  }

  getLiveTokens() {
    return Math.floor(this.getLivePending());
  }

  // ── Expansion ────────────────────────────────────────────
  async expandTo(x, y) {
    // Lock prevents rapid double-clicks from both passing the token check before DB returns
    if (this._expanding) return { ok: false, msg: 'Already processing expansion...' };
    if (!this.country || this.getLiveTokens() < 1) {
      return { ok: false, msg: 'No expansion tokens available. Come back later!' };
    }
    this._expanding = true;
    try {

    const key = `${x},${y}`;
    let pixel = this.pixelData[key];
    if (!pixel) {
      // Pixel row missing (seeding gap) — seed it on demand from the local map
      const tile = this.mapData?.[y]?.[x];
      if (!tile) return { ok: false, msg: 'Pixel not found.' };
      const { data, error } = await sb.from('pixels')
        .upsert({ game_id: this.gameId, x, y, terrain: tile.terrain }, { onConflict: 'game_id,x,y', ignoreDuplicates: true })
        .select().single();
      if (error || !data) {
        const { data: existing } = await sb.from('pixels').select('*').eq('game_id', this.gameId).eq('x', x).eq('y', y).single();
        if (!existing) return { ok: false, msg: 'Pixel not found.' };
        pixel = existing;
      } else {
        pixel = data;
      }
      this.pixelData[key] = pixel;
    }
    if (pixel.terrain === 'water') return { ok: false, msg: "Can't expand into water." };
    if (pixel.country_id === this.country.id) return { ok: false, msg: 'Already yours.' };

    // Must be adjacent to own territory
    if (!this._adjacentToOwn(x, y)) {
      return { ok: false, msg: 'Must expand to a pixel adjacent to your territory.' };
    }

    // If occupied, must attack instead
    if (pixel.country_id && pixel.country_id !== this.country.id) {
      return { ok: false, msg: 'Tile is occupied! Use Attack instead.', needsAttack: true };
    }

    // Claim the pixel
    const { error } = await sb.from('pixels')
      .update({ country_id: this.country.id, captured_at: new Date().toISOString() })
      .eq('game_id', this.gameId).eq('x', x).eq('y', y);

    if (error) return { ok: false, msg: error.message };

    const newPending = this.getLivePending() - 1;
    const newCount = this.country.pixel_count + 1;
    const { data: updatedCountry } = await sb.from('countries')
      .update({ pending_pixels: newPending, pixel_count: newCount, last_active: new Date().toISOString() })
      .eq('id', this.country.id).select().single();

    if (updatedCountry) this.country = updatedCountry;
    this.pixelData[key] = { ...pixel, country_id: this.country.id };

    await this._logEvent('expand', `${this.country.name} expanded to (${x},${y})`);
    return { ok: true, msg: `Expanded! Tokens left: ${this.getLiveTokens()}` };
    } finally {
      this._expanding = false;
    }
  }

  // ── Combat ────────────────────────────────────────────────
  async attack(x, y) {
    if (!this.country) return { ok: false, msg: 'No country.' };

    const key = `${x},${y}`;
    const pixel = this.pixelData[key];
    if (!pixel || !pixel.country_id) return { ok: false, msg: 'No enemy here.' };
    if (pixel.country_id === this.country.id) return { ok: false, msg: 'That is already yours.' };
    if (!this._adjacentToOwn(x, y)) return { ok: false, msg: 'Must attack adjacent tiles.' };

    const defender = this.countries[pixel.country_id];
    if (!defender) return { ok: false, msg: 'Defender not found.' };

    // Check active ceasefire
    const { data: ceasefireActive } = await sb.from('ceasefires')
      .select('id, expires_at')
      .or(`and(nation_a.eq.${this.country.id},nation_b.eq.${defender.id}),and(nation_a.eq.${defender.id},nation_b.eq.${this.country.id})`)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (ceasefireActive) {
      const minsLeft = Math.ceil((new Date(ceasefireActive.expires_at) - Date.now()) / 60000);
      return { ok: false, msg: `☮️ Ceasefire with ${defender.name} — ${minsLeft} min remaining.` };
    }

    // Reconcile defender's army to include offline regen before combat
    const defenderEstArmy = estimateDefenderArmy(defender, this.infraData, this.speed);
    if (defenderEstArmy !== defender.army_size) {
      await sb.from('countries').update({ army_size: defenderEstArmy, last_active: new Date().toISOString() }).eq('id', defender.id);
      defender.army_size = defenderEstArmy;
      this.countries[defender.id] = defender;
    }

    // Combat formula
    const wall = this.wallData[key];
    const wallBonus = wall ? CONFIG.INFRA_COSTS.wall.defenseBonus : 0;
    const terrainDef = (CONFIG.TERRAIN_DEFENSE[pixel.terrain] || 1) * (1 + wallBonus);
    const attackPower = this.country.army_size * (Math.random() * 0.4 + 0.8);
    const defensePower = defender.army_size * terrainDef * (Math.random() * 0.4 + 0.8);

    const success = attackPower > defensePower;
    const attackerLoss = success
      ? Math.ceil(defensePower * 0.175 + attackPower * 0.03)
      : Math.ceil(attackPower * 0.225);
    const defenderLoss = success
      ? Math.ceil(defensePower * 0.14)
      : Math.ceil(attackPower * 0.06);

    // Apply losses
    const newAttackerArmy = Math.max(1, this.country.army_size - attackerLoss);
    const newDefenderArmy = Math.max(1, defender.army_size - defenderLoss);

    await sb.from('countries').update({ army_size: newAttackerArmy })
      .eq('id', this.country.id);
    await sb.from('countries').update({ army_size: newDefenderArmy })
      .eq('id', defender.id);

    // Every attack (win or lose) raises the per-army food rate by 0.05, capped at +2.0 (army × 2.1 max)
    const aggressionGained = CONFIG.FOOD_AGGRESSION_PER_ATTACK;
    const curAggression = Number.isFinite(this.country.food_aggression) && this.country.food_aggression <= 2 ? this.country.food_aggression : 0;
    const newAggression = Math.min(2, Math.round((curAggression + aggressionGained) * 10000) / 10000);
    await sb.from('countries').update({ food_aggression: newAggression }).eq('id', this.country.id);
    this.country.food_aggression = newAggression;

    if (success) {
      await sb.from('pixels').update({ country_id: this.country.id, captured_at: new Date().toISOString() })
        .eq('game_id', this.gameId).eq('x', x).eq('y', y);
      await sb.from('countries').update({ pixel_count: this.country.pixel_count + 1, pixels_captured: (this.country.pixels_captured || 0) + 1 })
        .eq('id', this.country.id);
      const defNewPixels = Math.max(0, defender.pixel_count - 1);
      const defFoodCap = defNewPixels * CONFIG.FOOD_CAP_PER_PIXEL;
      const defFoodNow = Number.isFinite(defender.food) ? defender.food : 0;
      const defFoodUpdate = { pixel_count: defNewPixels, pixels_lost: (defender.pixels_lost || 0) + 1 };
      if (defFoodNow > defFoodCap) defFoodUpdate.food = defFoodCap;
      await sb.from('countries').update(defFoodUpdate).eq('id', defender.id);
      defender.pixel_count = defNewPixels;
      this.country.pixels_captured = (this.country.pixels_captured || 0) + 1;

      this.pixelData[key] = { ...pixel, country_id: this.country.id };
      this.country.pixel_count++;

      // Fortifications are always destroyed on capture
      const capturedWall = this.wallData[key];
      if (capturedWall) {
        await sb.from('infrastructure').delete().eq('id', capturedWall.id);
        delete this.wallData[key];
      }

      // 50/50: captured building is either transferred or destroyed
      const capturedInfra = this.infraData[key];
      if (capturedInfra) {
        if (Math.random() < 0.5) {
          // Transfer to attacker
          await sb.from('infrastructure').update({ country_id: this.country.id }).eq('id', capturedInfra.id);
          this.infraData[key] = { ...capturedInfra, country_id: this.country.id };
          // Apply stat effect to attacker
          const infraUpdates = {};
          if (capturedInfra.type === 'market') infraUpdates.army_upkeep_per_pixel = Math.max(0.02, this.country.army_upkeep_per_pixel - CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') infraUpdates.army_size = this.country.army_size + CONFIG.INFRA_COSTS.barracks.armyBonus;
          if (Object.keys(infraUpdates).length) {
            await sb.from('countries').update(infraUpdates).eq('id', this.country.id);
            Object.assign(this.country, infraUpdates);
          }
          // Remove stat effect from defender
          const defUpdates = {};
          if (capturedInfra.type === 'market') defUpdates.army_upkeep_per_pixel = Math.min(0.3, defender.army_upkeep_per_pixel + CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') defUpdates.army_size = Math.max(1, defender.army_size - CONFIG.INFRA_COSTS.barracks.armyBonus);
          if (Object.keys(defUpdates).length) await sb.from('countries').update(defUpdates).eq('id', defender.id);
        } else {
          // Destroy the building
          await sb.from('infrastructure').delete().eq('id', capturedInfra.id);
          delete this.infraData[key];
          // Remove stat effect from defender
          const defUpdates = {};
          if (capturedInfra.type === 'market') defUpdates.army_upkeep_per_pixel = Math.min(0.3, defender.army_upkeep_per_pixel + CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') defUpdates.army_size = Math.max(1, defender.army_size - CONFIG.INFRA_COSTS.barracks.armyBonus);
          if (Object.keys(defUpdates).length) await sb.from('countries').update(defUpdates).eq('id', defender.id);
        }
      }
    }

    this.country.army_size = newAttackerArmy;

    const msg = success
      ? `⚔️ Victory! Captured (${x},${y}). Lost ${attackerLoss} troops. 🍞 Food rate +${aggressionGained.toFixed(2)}/px`
      : `❌ Failed attack on (${x},${y}). Lost ${attackerLoss} troops. 🍞 Food rate +${aggressionGained.toFixed(2)}/px`;
    await this._logEvent('attack', `${this.country.name} attacked ${defender.name} at (${x},${y}) — ${success ? 'SUCCESS' : 'FAILED'}`);

    // Check if defender is eliminated (0 pixels = eliminated, regardless of army)
    const defenderPixelsLeft = Math.max(0, defender.pixel_count - (success ? 1 : 0));
    if (defenderPixelsLeft <= 0) {
      await sb.from('countries').update({ is_alive: false, surrendered_at: new Date().toISOString(), pixel_count: defenderPixelsLeft })
        .eq('id', defender.id);
      this.countries[defender.id] = { ...defender, is_alive: false, pixel_count: defenderPixelsLeft, army_size: newDefenderArmy };
      await this._logEvent('eliminated', `${this.country.name} has eliminated ${defender.name}!`);
      sb.from('profiles').select('id,total_kills').eq('id', this.playerId).single()
        .then(({ data: p, error: e }) => {
          if (e) { console.warn('[kills] select failed:', e.message); return; }
          if (p) sb.from('profiles').update({ total_kills: (p.total_kills || 0) + 1 }).eq('id', this.playerId)
            .then(({ error: ue }) => { if (ue) console.warn('[kills] update failed:', ue.message); });
        });
      await this._checkWinCondition();
    } else {
      this.countries[defender.id] = { ...defender, pixel_count: defenderPixelsLeft, army_size: newDefenderArmy };
    }

    return { ok: true, msg, success, attackerLoss, defenderLoss, aggressionGained, newAggression };
  }

  // ── Infrastructure ─────────────────────────────────────────
  async buildInfra(type, x, y) {
    if (!this.country) return { ok: false, msg: 'No country.' };
    const cost = CONFIG.INFRA_COSTS[type];
    if (!cost) return { ok: false, msg: 'Unknown building type.' };
    if (this.country.gold < cost.gold) {
      return { ok: false, msg: `Need ${cost.gold} gold. You have ${this.country.gold}.` };
    }

    const key = `${x},${y}`;
    if (this.pixelData[key]?.country_id !== this.country.id) {
      return { ok: false, msg: 'You must own this tile to build here.' };
    }

    if (type === 'wall') {
      // Fortifications are independent of building cap and can stack with any building
      if (this.wallData[key]) return { ok: false, msg: 'This tile is already fortified.' };
    } else {
      if (this.infraData[key]) return { ok: false, msg: 'A building already stands on this tile.' };
      const myBuildings = Object.values(this.infraData).filter(i => i.country_id === this.country.id);
      const buildingCap = Math.floor(this.country.pixel_count / 2);
      if (myBuildings.length >= buildingCap) {
        return { ok: false, msg: `Building cap reached (${myBuildings.length}/${buildingCap}). You need ${(myBuildings.length + 1) * 2} pixels to build more.` };
      }
    }
    if (type === 'market') {
      const myMarkets = Object.values(this.infraData).filter(i => i.country_id === this.country.id && i.type === 'market').length;
      if (myMarkets >= CONFIG.INFRA_COSTS.market.maxCount) {
        return { ok: false, msg: `Market cap reached (${myMarkets}/${CONFIG.INFRA_COSTS.market.maxCount}).` };
      }
    }
    if (type === 'barracks') {
      const myInfra = Object.values(this.infraData).filter(i => i.country_id === this.country.id);
      const existingBarracks = myInfra.filter(i => i.type === 'barracks').length;
      const population = this.country.pixel_count * CONFIG.POPULATION_PER_PIXEL;
      const requiredPop = (existingBarracks + 1) * CONFIG.BARRACKS_POPULATION_COST;
      if (population < requiredPop) {
        return { ok: false, msg: `Need population of ${requiredPop} for barracks #${existingBarracks + 1}. You have ${population} — expand to ${Math.ceil(requiredPop / CONFIG.POPULATION_PER_PIXEL)} pixels.` };
      }
    }
    if (type === 'harbor') {
      const tile = this.mapData?.[y]?.[x];
      if (!tile || tile.terrain === 'water') return { ok: false, msg: 'Harbours must be built on land.' };
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      const bordersWater = dirs.some(([dx, dy]) => {
        const t = this.mapData?.[y + dy]?.[x + dx];
        return t && t.terrain === 'water';
      });
      if (!bordersWater) return { ok: false, msg: 'Harbours must be built on a land tile bordering water.' };
    }

    const { data: infra, error } = await sb.from('infrastructure').insert({
      country_id: this.country.id,
      game_id: this.gameId,
      type, pixel_x: x, pixel_y: y,
    }).select().single();
    if (error) return { ok: false, msg: error.message };

    if (type === 'wall') this.wallData[key] = infra;
    else this.infraData[key] = infra;

    const newGold = this.country.gold - cost.gold;
    let updates = { gold: newGold };

    if (type === 'barracks') updates.army_size = this.country.army_size + cost.armyBonus;
    if (type === 'market') updates.army_upkeep_per_pixel = Math.max(0.02, this.country.army_upkeep_per_pixel - cost.upkeepReduction);
    // farm: income computed dynamically from terrain; mine/wall: handled in tick/attack

    await sb.from('countries').update(updates).eq('id', this.country.id);
    Object.assign(this.country, updates);

    await this._logEvent('build', `${this.country.name} built a ${type} at (${x},${y})`);
    return { ok: true, msg: `Built ${type}! (${cost.effect})` };
  }

  // ── Boats ─────────────────────────────────────────────────
  _findWaterPath(fromX, fromY, toX, toY) {
    const W = this.game.map_width, H = this.game.map_height;
    const isWater = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      return this.mapData?.[y]?.[x]?.terrain === 'water';
    };
    // Start tiles: water tiles adjacent to fromX,fromY
    const starts = [[1,0],[-1,0],[0,1],[0,-1]]
      .map(([dx,dy]) => [fromX+dx, fromY+dy])
      .filter(([x,y]) => isWater(x,y));
    // End tiles: water tiles adjacent to toX,toY
    const endSet = new Set(
      [[1,0],[-1,0],[0,1],[0,-1]]
        .map(([dx,dy]) => [toX+dx, toY+dy])
        .filter(([x,y]) => isWater(x,y))
        .map(([x,y]) => `${x},${y}`)
    );
    if (!starts.length || !endSet.size) return null;

    const visited = new Set();
    const queue = starts.map(s => ({ x: s[0], y: s[1], path: [{ x: s[0], y: s[1] }] }));
    queue.forEach(q => visited.add(`${q.x},${q.y}`));

    while (queue.length) {
      const { x, y, path } = queue.shift();
      if (endSet.has(`${x},${y}`)) return path;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x+dx, ny = y+dy;
        const key = `${nx},${ny}`;
        if (!visited.has(key) && isWater(nx, ny)) {
          visited.add(key);
          queue.push({ x: nx, y: ny, path: [...path, { x: nx, y: ny }] });
        }
      }
    }
    return null;
  }

  async loadBoats() {
    this.boatData = {};
const { data } = await sb.from('boats').select('*')
      .eq('game_id', this.gameId).eq('status', 'sailing');
    (data || []).forEach(b => { this.boatData[b.id] = b; });

    const sub = sb.channel(`boats:${this.gameId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'boats', filter: `game_id=eq.${this.gameId}` }, async payload => {
        if (!payload.new) return;
        // path may be stripped from realtime payload if large — re-fetch to be safe
        if (!payload.new.path || !payload.new.path.length) {
          const { data } = await sb.from('boats').select('*').eq('id', payload.new.id).single();
          if (data) this.boatData[data.id] = data;
        } else {
          this.boatData[payload.new.id] = payload.new;
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'boats', filter: `game_id=eq.${this.gameId}` }, payload => {
        if (payload.new?.status !== 'sailing') delete this.boatData[payload.new.id];
        else if (payload.new) this.boatData[payload.new.id] = payload.new;
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'boats', filter: `game_id=eq.${this.gameId}` }, payload => {
        if (payload.old?.id) delete this.boatData[payload.old.id];
      })
      .subscribe();
    this.realtimeSubs.push(sub);
  }

  async sendBoat(toX, toY, mode) {
    if (!this.country) return { ok: false, msg: 'No country.' };
    const myHarbors = Object.values(this.infraData).filter(i => i.country_id === this.country.id && i.type === 'harbor');
    if (!myHarbors.length) return { ok: false, msg: 'Build a harbour first (⚓ 180g).' };

    // Target must border water
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    const toTile = this.mapData?.[toY]?.[toX];
    if (!toTile || toTile.terrain === 'water') return { ok: false, msg: 'Target must be a land tile.' };
    const toBordersWater = dirs.some(([dx,dy]) => this.mapData?.[toY+dy]?.[toX+dx]?.terrain === 'water');
    if (!toBordersWater) return { ok: false, msg: 'Target tile must border water to receive a boat.' };

    // Attack validation
    const targetPixel = this.pixelData[`${toX},${toY}`];
    if (mode === 'attack') {
      if (!targetPixel?.country_id || targetPixel.country_id === this.country.id) {
        return { ok: false, msg: 'Choose an enemy tile to attack by boat.' };
      }
    }

    // Find shortest path from any harbor
    let bestPath = null, bestHarbor = null;
    for (const h of myHarbors) {
      const path = this._findWaterPath(h.pixel_x, h.pixel_y, toX, toY);
      if (path && (!bestPath || path.length < bestPath.length)) {
        bestPath = path;
        bestHarbor = h;
      }
    }
    if (!bestPath) return { ok: false, msg: 'No water route found to that tile from any of your harbours.' };

    // For expand: deduct 1 token
    if (mode === 'expand') {
      if (this.getLiveTokens() < 1) return { ok: false, msg: 'No expansion tokens available.' };
      if (targetPixel?.country_id === this.country.id) return { ok: false, msg: 'You already own that tile.' };
    }

    const now = new Date();
    const boatMinutes = CONFIG.BOAT_MINUTES_PER_TILE / (this.speed || 1);
    const arrivesAt = new Date(now.getTime() + bestPath.length * boatMinutes * 60000);

    const { data, error } = await sb.from('boats').insert({
      game_id: this.gameId,
      country_id: this.country.id,
      from_harbor_id: bestHarbor.id,
      to_x: toX, to_y: toY,
      mode,
      path: bestPath,
      status: 'sailing',
      created_at: now.toISOString(),
      arrives_at: arrivesAt.toISOString(),
    }).select().single();

    if (error) return { ok: false, msg: error.message };

    if (mode === 'expand') {
      const newPending = this.getLivePending() - 1;
      await sb.from('countries').update({ pending_pixels: newPending, last_active: now.toISOString() }).eq('id', this.country.id);
      this.country.pending_pixels = newPending;
    }

    this.boatData[data.id] = data;
    const eta = Math.round(bestPath.length * boatMinutes);
    await this._logEvent('build', `${this.country.name} deployed a boat towards (${toX},${toY}) — ETA ${eta} min`);
    return { ok: true, msg: `⛵ Boat deployed! Arrives in ~${eta} minutes.` };
  }

  async upgradeInfra(infraId) {
    const infra = Object.values(this.infraData || {}).find(i => i.id === infraId);
    if (!infra || infra.country_id !== this.country?.id) return { ok: false, msg: 'Building not found.' };
    if (infra.type !== 'farm') return { ok: false, msg: 'Only farms can be upgraded.' };
    if ((infra.level || 1) >= 2) return { ok: false, msg: 'Already upgraded.' };
    const cost = CONFIG.INFRA_COSTS.farm.upgradeCost;
    if (this.country.gold < cost) return { ok: false, msg: `Need ${cost} gold to upgrade.` };
    const { data, error } = await sb.from('infrastructure').update({ level: 2 }).eq('id', infraId).select().single();
    if (error) return { ok: false, msg: error.message };
    this.infraData[`${infra.pixel_x},${infra.pixel_y}`] = data;
    const { data: c2 } = await sb.from('countries').update({ gold: this.country.gold - cost }).eq('id', this.country.id).select().single();
    if (c2) this.country = c2;
    await this._logEvent('build', `${this.country.name} upgraded a farm at (${infra.pixel_x},${infra.pixel_y}) to level 2`);
    return { ok: true, msg: '🌾 Farm upgraded! Now produces 10 food/hr.' };
  }

  async cancelBoat(boatId) {
    const boat = this.boatData?.[boatId];
    if (!boat) return { ok: false, msg: 'Boat already arrived or not found.' };
    const { error } = await sb.from('boats').update({ status: 'cancelled' }).eq('id', boatId).eq('country_id', this.country?.id);
    if (error) return { ok: false, msg: 'Failed to cancel boat.' };
    delete this.boatData[boatId];
    // Refund expansion token if it was an expand mission
    if (boat.mode === 'expand') {
      const newPending = Math.min(CONFIG.MAX_STACK, (this.country.pending_pixels || 0) + 1);
      await sb.from('countries').update({ pending_pixels: newPending }).eq('id', this.country.id);
      this.country.pending_pixels = newPending;
    }
    return { ok: true, msg: '⛵ Boat recalled.' };
  }

  async tickBoats() {
    if (!this.boatData || !this.country) return;
    const now = new Date();
    for (const boat of Object.values(this.boatData)) {
      if (boat.country_id !== this.country.id) continue;
      if (new Date(boat.arrives_at) > now) continue;

      const { to_x: x, to_y: y, mode, id } = boat;
      const key = `${x},${y}`;
      const targetPixel = this.pixelData[key];

      if (mode === 'expand') {
        if (!targetPixel?.country_id) {
          // Claim it
          await sb.from('pixels').update({ country_id: this.country.id, captured_at: now.toISOString() }).eq('game_id', this.gameId).eq('x', x).eq('y', y);
          this.pixelData[key] = { ...targetPixel, country_id: this.country.id };
          await sb.from('countries').update({ pixel_count: this.country.pixel_count + 1 }).eq('id', this.country.id);
          this.country.pixel_count++;
          await sb.from('boats').delete().eq('id', id);
          await this._logEvent('expand', `${this.country.name}'s boat landed and claimed (${x},${y})!`);
          showToast(`⛵ Boat landed! Claimed (${x},${y}).`, 'ok');
        } else {
          // Tile taken — refund token
          const newPending = Math.min(CONFIG.MAX_STACK, (this.country.pending_pixels || 0) + 1);
          await sb.from('countries').update({ pending_pixels: newPending }).eq('id', this.country.id);
          this.country.pending_pixels = newPending;
          await sb.from('boats').delete().eq('id', id);
          await this._logEvent('expand', `${this.country.name}'s boat arrived but (${x},${y}) was already taken. Token refunded.`);
          showToast(`⛵ Boat failed — tile was taken. Token refunded.`, 'error');
        }
      } else if (mode === 'attack') {
        if (targetPixel?.country_id && targetPixel.country_id !== this.country.id) {
          // Run combat (same formula, no adjacency needed)
          const defender = this.countries[targetPixel.country_id];
          if (defender) {
            const wall = this.wallData[key];
            const wallBonus = wall ? CONFIG.INFRA_COSTS.wall.defenseBonus : 0;
            const terrainDef = (CONFIG.TERRAIN_DEFENSE[targetPixel.terrain] || 1) * (1 + wallBonus);
            const attackPower = this.country.army_size * (Math.random() * 0.4 + 0.8);
            const defensePower = defender.army_size * terrainDef * (Math.random() * 0.4 + 0.8);
            const success = attackPower > defensePower;
            const attackerLoss = success ? Math.ceil(defensePower * 0.175 + attackPower * 0.03) : Math.ceil(attackPower * 0.225);
            const defenderLoss = success ? Math.ceil(defensePower * 0.14) : Math.ceil(attackPower * 0.06);
            const newAttackerArmy = Math.max(1, this.country.army_size - attackerLoss);
            const newDefenderArmy = Math.max(1, defender.army_size - defenderLoss);
            await sb.from('countries').update({ army_size: newAttackerArmy }).eq('id', this.country.id);
            await sb.from('countries').update({ army_size: newDefenderArmy }).eq('id', defender.id);
            this.country.army_size = newAttackerArmy;
            if (success) {
              await sb.from('pixels').update({ country_id: this.country.id, captured_at: now.toISOString() }).eq('game_id', this.gameId).eq('x', x).eq('y', y);
              this.pixelData[key] = { ...targetPixel, country_id: this.country.id };
              await sb.from('countries').update({ pixel_count: this.country.pixel_count + 1 }).eq('id', this.country.id);
              await sb.from('countries').update({ pixel_count: Math.max(0, defender.pixel_count - 1) }).eq('id', defender.id);
              this.country.pixel_count++;
              showToast(`⛵ Boat attack succeeded! Captured (${x},${y}). Lost ${attackerLoss} troops.`, 'ok');
            } else {
              showToast(`⛵ Boat attack failed on (${x},${y}). Lost ${attackerLoss} troops.`, 'error');
            }
            await sb.from('boats').delete().eq('id', id);
            await this._logEvent('attack', `${this.country.name}'s boat attacked ${defender.name} at (${x},${y}) — ${success ? 'SUCCESS' : 'FAILED'}`);
            const defenderPixelsLeft = Math.max(0, defender.pixel_count - (success ? 1 : 0));
            if (defenderPixelsLeft <= 0) {
              await sb.from('countries').update({ is_alive: false, surrendered_at: now.toISOString() }).eq('id', defender.id);
              this.countries[defender.id] = { ...defender, is_alive: false };
              await this._logEvent('eliminated', `${this.country.name} has eliminated ${defender.name}!`);
              sb.from('profiles').select('id,total_kills').eq('id', this.playerId).single()
        .then(({ data: p, error: e }) => {
          if (e) { console.warn('[kills] select failed:', e.message); return; }
          if (p) sb.from('profiles').update({ total_kills: (p.total_kills || 0) + 1 }).eq('id', this.playerId)
            .then(({ error: ue }) => { if (ue) console.warn('[kills] update failed:', ue.message); });
        });
              await this._checkWinCondition();
            }
          } else {
            await sb.from('boats').delete().eq('id', id);
          }
        } else {
          await sb.from('boats').delete().eq('id', id);
          showToast(`⛵ Boat arrived but no enemy at (${x},${y}).`, 'error');
        }
      }
      delete this.boatData[id];
    }
  }

  // ── Trade ─────────────────────────────────────────────────
  async offerTrade(toCountryId, goldAmount, message) {
    if (this.country.gold < goldAmount) return { ok: false, msg: 'Not enough gold.' };
    const row = {
      game_id: this.gameId,
      from_country_id: this.country.id,
      to_country_id: toCountryId,
      gold_offered: goldAmount,
    };
    if (message) row.message = message.slice(0, 200);
    const { error } = await sb.from('trades').insert(row);
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'Trade offer sent!' };
  }

  async acceptTrade(tradeId) {
    const { data: trade } = await sb.from('trades').select('*').eq('id', tradeId).single();
    if (!trade || trade.status !== 'pending') return { ok: false, msg: 'Trade not available.' };

    const sender = this.countries[trade.from_country_id];
    if (!sender || sender.gold < trade.gold_offered) return { ok: false, msg: 'Sender lacks funds.' };

    // Transfer gold
    await sb.from('countries').update({ gold: sender.gold - trade.gold_offered }).eq('id', sender.id);
    await sb.from('countries').update({ gold: this.country.gold + trade.gold_offered }).eq('id', this.country.id);
    await sb.from('trades').update({ status: 'accepted', resolved_at: new Date().toISOString() }).eq('id', tradeId);

    this.country.gold += trade.gold_offered;
    await this._logEvent('trade', `${sender.name} sent ${trade.gold_offered} gold to ${this.country.name}`);
    return { ok: true, msg: `Received ${trade.gold_offered} gold!` };
  }

  // ── Win condition & cleanup ───────────────────────────────
  async _checkWinCondition() {
    const all = Object.values(this.countries);
    const alive = all.filter(c => c.is_alive);
    if (alive.length !== 1) return;

    await this._finishGame(alive[0]);
  }

  async _finishGame(winner) {
    // Fetch ALL countries (alive + eliminated) so everyone gets credited
    const { data: allCountries } = await sb.from('countries').select('*').eq('game_id', this.gameId);
    for (const c of (allCountries || [])) {
      const { data: profile } = await sb.from('profiles').select('total_wins, total_pixels_ever, games_played').eq('id', c.player_id).single();
      if (!profile) continue;
      await sb.from('profiles').update({
        total_wins: (profile.total_wins || 0) + (c.id === winner.id ? 1 : 0),
        total_pixels_ever: (profile.total_pixels_ever || 0) + (c.pixel_count || 0),
        games_played: (profile.games_played || 0) + 1,
      }).eq('id', c.player_id);
    }

    const finishedAt = new Date();
    const isAdminCreated = !!this.game?.is_admin_created;

    const gameUpdate = {
      status: 'finished',
      is_open: false,
      winner_id: winner.player_id,
      finished_at: finishedAt.toISOString(),
    };
    if (!isAdminCreated) {
      gameUpdate.delete_at = new Date(finishedAt.getTime() + 48 * 60 * 60 * 1000).toISOString();
    }
    await sb.from('games').update(gameUpdate).eq('id', this.gameId);

    const winMsg = isAdminCreated
      ? `🏆 ${winner.name} has conquered the realm! This is a permanent event world and will remain available.`
      : `🏆 ${winner.name} has conquered the realm! The world will be deleted in 48 hours.`;
    await this._logEvent('eliminated', winMsg);

    // Let connected clients show a victory screen before the data is wiped
    const gameOverPayload = { winnerName: winner.name, winnerId: winner.player_id, permanent: isAdminCreated };
    await sb.channel(`gameover:${this.gameId}`).send({
      type: 'broadcast', event: 'gameover', payload: gameOverPayload
    });
    // Supabase broadcast doesn't echo to sender, so fire locally too
    if (this._onGameOver) this._onGameOver(gameOverPayload);

    // Admin-created event realms stay permanently — no replacement needed
    if (isAdminCreated) return;

    // Open a fresh world for this category so the lobby doesn't go empty
    const cat = this.game?.category;
    if (cat) {
      const catCfg = {
        small:  { maxPlayers: 20, mapWidth: 60,  mapHeight: 50,  label: 'Small Realm' },
        medium: { maxPlayers: 35, mapWidth: 100, mapHeight: 80,  label: 'Medium Realm' },
        big:    { maxPlayers: 50, mapWidth: 150, mapHeight: 120, label: 'Grand Realm' },
      };
      const cfg = catCfg[cat];
      if (cfg) {
        const { data: existing } = await sb.from('games').select('id').eq('category', cat).eq('is_open', true).neq('id', this.gameId).limit(1);
        if (!existing?.length) {
          const { count } = await sb.from('games').select('id', { count: 'exact', head: true }).eq('category', cat);
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          let code = 'PR-';
          for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
          await sb.from('games').insert({ name: `${cfg.label} #${(count || 0) + 1}`, code, category: cat, is_open: true, max_players: cfg.maxPlayers, map_width: cfg.mapWidth, map_height: cfg.mapHeight, map_seed: Math.floor(Math.random() * 9999999), status: 'waiting' });
        }
      }
    }

  }

  // ── Helpers ──────────────────────────────────────────────
  _adjacentToOwn(x, y) {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    return dirs.some(([dx, dy]) => {
      const neighbor = this.pixelData[`${x+dx},${y+dy}`];
      return neighbor && neighbor.country_id === this.country.id;
    });
  }

  async _logEvent(type, message) {
    await sb.from('game_events').insert({
      game_id: this.gameId, type, message, country_id: this.country?.id
    });
  }

  // ── Realtime subscriptions ───────────────────────────────
  subscribeToMap(onPixelChange) {
    const sub = sb.channel(`map:${this.gameId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'pixels',
        filter: `game_id=eq.${this.gameId}`
      }, payload => {
        const p = payload.new;
        this.pixelData[`${p.x},${p.y}`] = p;
        onPixelChange(p);
      }).subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeToEvents(onEvent) {
    const sub = sb.channel(`events:${this.gameId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'game_events',
        filter: `game_id=eq.${this.gameId}`
      }, payload => onEvent(payload.new))
      .subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeToCountries(onUpdate) {
    const sub = sb.channel(`countries:${this.gameId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'countries',
        filter: `game_id=eq.${this.gameId}`
      }, payload => {
        this.countries[payload.new.id] = payload.new;
        if (payload.new.player_id === this.playerId) {
          // Merge realtime update but preserve in-memory gold if DB returns null/NaN
          // (Postgres stores NaN as null in JSON; tickIncome already updated the local value)
          const safeGold = Number.isFinite(payload.new.gold) ? payload.new.gold : (this.country?.gold ?? 0);
          const safeFood = Number.isFinite(payload.new.food) ? payload.new.food : (this.country?.food ?? 0);
          this.country = { ...payload.new, gold: safeGold, food: safeFood };
        }
        onUpdate(payload.new);
      }).subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeToMessages(onMessage) {
    const sub = sb.channel(`chat:${this.gameId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `game_id=eq.${this.gameId}`
      }, payload => onMessage(payload.new))
      .subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeToInfra(onInfra) {
    const sub = sb.channel(`infra:${this.gameId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'infrastructure',
        filter: `game_id=eq.${this.gameId}`
      }, payload => {
        const i = payload.new;
        const key = `${i.pixel_x},${i.pixel_y}`;
        if (i.type === 'wall') this.wallData[key] = i;
        else this.infraData[key] = i;
        onInfra(i);
      }).subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeTrades(onTrade) {
    const sub = sb.channel(`trades:${this.gameId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'trades',
        filter: `game_id=eq.${this.gameId}`
      }, payload => onTrade(payload))
      .subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  subscribeToGameOver(onGameOver) {
    this._onGameOver = onGameOver;
    const sub = sb.channel(`gameover:${this.gameId}`)
      .on('broadcast', { event: 'gameover' }, payload => onGameOver(payload.payload))
      .subscribe();
    this.realtimeSubs.push(sub);
    return sub;
  }

  destroy() {
    this.realtimeSubs.forEach(s => sb.removeChannel(s));
  }
}

// ── Income ticker (runs client-side every few seconds for a smooth counter) ─
// Mine income with diminishing returns:
// Each additional mine reduces flat income by 1g/hr and pixel bonus by 0.01/px
// mineInfra: array of {pixel_x, pixel_y} mine records; pixelData: engine.pixelData
function calcMineIncome(mineInfra, pixelCount, pixelData) {
  if (!mineInfra || mineInfra.length === 0) return 0;
  let total = 0;
  mineInfra.forEach((m, i) => {
    const terrain = pixelData?.[`${m.pixel_x},${m.pixel_y}`]?.terrain || 'grass';
    const terrainMult = CONFIG.MINE_TERRAIN_MULT[terrain] ?? 1.0;
    const baseFlat = Math.max(0, CONFIG.INFRA_COSTS.mine.flatIncome - i * 0.1);
    const pixelBonus = Math.max(0, CONFIG.INFRA_COSTS.mine.pixelBonus - i * 0.002);
    total += baseFlat * terrainMult + pixelBonus * pixelCount;
  });
  return total;
}

// farmInfra: array of {pixel_x, pixel_y} farm records
function calcFarmIncome(farmInfra, pixelCount, pixelData) {
  if (!farmInfra || farmInfra.length === 0) return 0;
  return farmInfra.reduce((sum, f) => {
    const terrain = pixelData?.[`${f.pixel_x},${f.pixel_y}`]?.terrain || 'grass';
    const terrainMult = CONFIG.FARM_TERRAIN_MULT[terrain] ?? 1.0;
    return sum + CONFIG.INFRA_COSTS.farm.incomeBonus * terrainMult * pixelCount;
  }, 0);
}

function calcBorderUpkeepRate(pixelCount) {
  if (pixelCount <= 15) return 2;
  if (pixelCount <= 40) return 5;
  if (pixelCount <= 80) return 8;
  return 10;
}

// Returns border pixel count, neighboring nations count, and gold/hr cost
function calcBorderUpkeep(pixelData, myCountryId, myPixelCount) {
  let borderPixels = 0;
  const neighborNations = new Set();
  for (const [key, p] of Object.entries(pixelData)) {
    if (p.country_id !== myCountryId) continue;
    const [x, y] = key.split(',').map(Number);
    let hasForeignNeighbor = false;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const n = pixelData[`${x+dx},${y+dy}`];
      if (n?.country_id && n.country_id !== myCountryId) {
        hasForeignNeighbor = true;
        neighborNations.add(n.country_id);
      }
    }
    if (hasForeignNeighbor) borderPixels++;
  }
  const rate = calcBorderUpkeepRate(myPixelCount ?? Object.values(pixelData).filter(p => p.country_id === myCountryId).length);
  return { borderPixels, nations: neighborNations.size, cost: borderPixels * rate, rate };
}

// Returns food/hr balance (positive = surplus, negative = deficit)
// aggression = extra per-army food rate added by war (e.g. 0.05 per attack)
// Pixels stay fixed: px × 0.10
// No war:       army × 0.10
// After 1 attack: army × 0.15  (aggression = 0.05)
// After 2 attacks: army × 0.20 (aggression = 0.10)
function calcTradingPostIncome(tradingPostInfra, pixelData, borderNations) {
  if (!tradingPostInfra || tradingPostInfra.length === 0) return 0;
  return tradingPostInfra.reduce((sum, t) => {
    const terrain = pixelData?.[`${t.pixel_x},${t.pixel_y}`]?.terrain || 'grass';
    const mult = CONFIG.TRADING_POST_TERRAIN_MULT[terrain] ?? 0.9;
    return sum + (CONFIG.INFRA_COSTS.trading_post.flatIncome + borderNations * CONFIG.INFRA_COSTS.trading_post.incomePerNation) * mult;
  }, 0);
}

// Returns total food/hr produced by farms, accounting for upgrades (level 2 = 10/hr, level 1 = 5/hr)
function calcFarmFoodProduction(farmInfra) {
  if (!farmInfra || farmInfra.length === 0) return 0;
  return farmInfra.reduce((sum, f) => sum + (f.level >= 2 ? CONFIG.INFRA_COSTS.farm.upgradedFoodPerHour : CONFIG.FOOD_PRODUCTION_PER_FARM), 0);
}

// War production penalty: 0 aggression = ×1.0, 1.0 = ×0.5, 2.0+ = ×0.25
function warFoodMult(aggression) {
  return Math.max(0.25, Math.pow(0.5, aggression || 0));
}

function calcFoodBalance(farmInfraOrCount, pixelCount, armySize, aggression = 0) {
  const farmFood = Array.isArray(farmInfraOrCount)
    ? calcFarmFoodProduction(farmInfraOrCount)
    : farmInfraOrCount * CONFIG.FOOD_PRODUCTION_PER_FARM;
  const rawProduction = pixelCount * CONFIG.FOOD_PRODUCTION_PER_PIXEL + farmFood;
  const production = rawProduction * warFoodMult(aggression);
  const armyRate = CONFIG.FOOD_CONSUMPTION_PER_ARMY + (aggression || 0);
  const consumption = pixelCount * CONFIG.FOOD_CONSUMPTION_PER_PIXEL + (armySize || 0) * armyRate;
  return production - consumption;
}

// Tiered territory upkeep — small nations pay far less to ease early game
function estimateDefenderArmy(defender, infraData, speed) {
  const lastActive = defender.last_active ? new Date(defender.last_active).getTime() : null;
  const hoursElapsed = lastActive ? Math.min(48, (Date.now() - lastActive) / 3600000) : 0;
  if (hoursElapsed < 0.05) return defender.army_size || 0;
  const scaledHours = hoursElapsed * (speed || 1);
  const myInfra = Object.values(infraData || {}).filter(i => i.country_id === defender.id);
  const barracks = myInfra.filter(i => i.type === 'barracks').length;
  const armyCap = barracks * CONFIG.INFRA_COSTS.barracks.armyBonus;
  const currentArmy = defender.army_size || 0;
  if (barracks <= 0 || currentArmy >= armyCap) return currentArmy;
  return Math.min(armyCap, Math.floor(currentArmy + barracks * CONFIG.BARRACKS_REGEN_PER_HOUR * scaledHours));
}

function calcTierUpkeepRate(pixelCount) {
  if (pixelCount <= 15) return 0.05;
  if (pixelCount <= 40) return 0.15;
  if (pixelCount <= 80) return 0.22;
  return 0.30;
}

async function tickIncome(engine) {
  if (!engine.country) return;
  const c = engine.country;
  const myInfra = Object.values(engine.infraData || {}).filter(i => i.country_id === c.id);
  const mineInfra = myInfra.filter(i => i.type === 'mine');
  const farmInfra = myInfra.filter(i => i.type === 'farm');
  const tradingPostInfra = myInfra.filter(i => i.type === 'trading_post');

  const markets = myInfra.filter(i => i.type === 'market').length;
  const incomePerPx = c.income_per_pixel || CONFIG.BASE_INCOME_PER_PIXEL;
  const baseUpkeepRate = calcTierUpkeepRate(c.pixel_count);
  const effectiveUpkeepRate = Math.max(0.02, baseUpkeepRate - markets * CONFIG.INFRA_COSTS.market.upkeepReduction);
  const baseIncome = incomePerPx * c.pixel_count;
  const farmIncome = calcFarmIncome(farmInfra, c.pixel_count, engine.pixelData);
  const mineIncome = calcMineIncome(mineInfra, c.pixel_count, engine.pixelData);
  const border = calcBorderUpkeep(engine.pixelData, c.id, c.pixel_count);
  const tradingPostIncome = calcTradingPostIncome(tradingPostInfra, engine.pixelData, border.nations);

  const aggression = Number.isFinite(c.food_aggression) ? c.food_aggression : 0;
  const foodBalance = calcFoodBalance(farmInfra, c.pixel_count, c.army_size, aggression);
  const foodThreshold = c.pixel_count * CONFIG.POPULATION_PER_PIXEL * 0.5;
  const currentFood = Number.isFinite(c.food) ? c.food : 0;
  const foodMult = (foodThreshold > 0 && currentFood < foodThreshold)
    ? Math.max(0.2, currentFood / foodThreshold)
    : 1;

  const hourlyIncome = (baseIncome + farmIncome + mineIncome + tradingPostIncome) * foodMult;
  const pixelUpkeep = Math.max(0, effectiveUpkeepRate * c.pixel_count);
  const armyUpkeep = c.army_size * CONFIG.ARMY_UPKEEP_PER_UNIT;
  const harborCount = myInfra.filter(i => i.type === 'harbor').length;
  const harborUpkeep = harborCount * CONFIG.INFRA_COSTS.harbor.upkeepPerHour;
  const borderCost = Math.min(border.cost, hourlyIncome);
  const netHourly = hourlyIncome - pixelUpkeep - armyUpkeep - borderCost - harborUpkeep;

  const speed = engine.speed || 1;
  const tickHours = CONFIG.INCOME_TICK_SECONDS / 3600 * speed;
  const tick = netHourly * tickHours;
  const safeGold = Number.isFinite(c.gold) ? c.gold : 0;
  const newGold = Math.max(0, Math.round((safeGold + tick) * 10000) / 10000);

  // Update gold first — critical, must not be blocked by food column issues
  if (newGold !== safeGold) {
    const { error } = await sb.from('countries').update({ gold: newGold }).eq('id', c.id);
    if (!error) engine.country.gold = newGold;
  }

  // Food storage — separate update so food column issues never affect gold
  const safeFood = Number.isFinite(c.food) ? c.food : 0;
  const foodCap = c.pixel_count * CONFIG.FOOD_CAP_PER_PIXEL;
  const newFood = Math.min(foodCap, Math.max(0, Math.round((safeFood + foodBalance * tickHours) * 100) / 100));
  if (newFood !== safeFood) {
    const { error } = await sb.from('countries').update({ food: newFood }).eq('id', c.id);
    if (!error) engine.country.food = newFood;
  }

  // War aggression decays — base rate boosted by markets owned
  const effectiveDecay = CONFIG.FOOD_AGGRESSION_DECAY + markets * CONFIG.MARKET_DECAY_BONUS;
  const newAggression = Math.max(0, Math.round((aggression - effectiveDecay * tickHours) * 100000) / 100000);
  if (newAggression !== aggression) {
    const { error } = await sb.from('countries').update({ food_aggression: newAggression }).eq('id', c.id);
    if (!error) engine.country.food_aggression = newAggression;
  }

  // Boat arrivals
  await engine.tickBoats();

  // Army regeneration — barracks refill army up to their cap (barracks × 20) at 0.5/hr per barracks
  // Uses actual wall-clock elapsed time so browser tab throttling doesn't starve regen
  const barracksCount = myInfra.filter(i => i.type === 'barracks').length;
  const now = Date.now();
  const regenElapsedHours = (engine._lastRegenTime ? (now - engine._lastRegenTime) / 3600000 : tickHours / speed) * speed;
  engine._lastRegenTime = now;
  if (barracksCount > 0 && c.army_size < barracksCount * CONFIG.INFRA_COSTS.barracks.armyBonus) {
    engine._armyRegenAccum = (engine._armyRegenAccum || 0) + barracksCount * CONFIG.BARRACKS_REGEN_PER_HOUR * regenElapsedHours;
    const wholeRegen = Math.floor(engine._armyRegenAccum);
    if (wholeRegen >= 1) {
      engine._armyRegenAccum -= wholeRegen;
      const armyCap = barracksCount * CONFIG.INFRA_COSTS.barracks.armyBonus;
      const newArmy = Math.min(armyCap, c.army_size + wholeRegen);
      const { error } = await sb.from('countries').update({ army_size: newArmy }).eq('id', c.id);
      if (!error) engine.country.army_size = newArmy;
    }
  }
}
