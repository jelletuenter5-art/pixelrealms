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

  async load() {
    const [gameRes, countryRes, pixels, countriesRes, infraRes] = await Promise.all([
      sb.from('games').select('*').eq('id', this.gameId).single(),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('player_id', this.playerId).single(),
      this._fetchAllPixels(),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('is_alive', true),
      sb.from('infrastructure').select('*').eq('game_id', this.gameId),
    ]);

    this.game = gameRes.data;
    this.country = countryRes.data;

    // Index pixel data
    pixels.forEach(p => {
      this.pixelData[`${p.x},${p.y}`] = p;
    });

    // Index countries
    (countriesRes.data || []).forEach(c => {
      this.countries[c.id] = c;
    });

    // Index infrastructure (one building per tile)
    this.infraData = {};
    (infraRes.data || []).forEach(i => {
      this.infraData[`${i.pixel_x},${i.pixel_y}`] = i;
    });

    // Calculate pending pixels from time offline
    if (this.country) {
      await this.accruePendingPixels();
      await this._reconcileCountryStats();
    }

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
    const correctIncome = CONFIG.BASE_INCOME_PER_PIXEL + farms * CONFIG.INFRA_COSTS.farm.incomeBonus;
    const correctUpkeep = Math.max(0.02, 0.3 - markets * CONFIG.INFRA_COSTS.market.upkeepReduction);

    const updates = {};
    if (correctPixelCount !== this.country.pixel_count) updates.pixel_count = correctPixelCount;
    if (Math.abs(correctIncome - this.country.income_per_pixel) > 1e-6) updates.income_per_pixel = correctIncome;
    if (Math.abs(correctUpkeep - this.country.army_upkeep_per_pixel) > 1e-6) updates.army_upkeep_per_pixel = correctUpkeep;

    if (Object.keys(updates).length > 0) {
      const { data } = await sb.from('countries').update(updates).eq('id', this.country.id).select().single();
      if (data) this.country = data;
    }
  }

  // ── Pixel Accrual (offline expansion tokens) ─────────────
  async accruePendingPixels() {
    const last = new Date(this.country.last_active);
    const now = new Date();
    const hoursOffline = (now - last) / 3600000;

    if (hoursOffline < 0.05) return; // < 3 min, skip

    const newTokens = Math.min(
      this.country.pending_pixels + hoursOffline * CONFIG.PIXELS_PER_HOUR,
      CONFIG.MAX_STACK
    );

    // Gold also accrues while offline, based on the same elapsed time
    const mines = Object.values(this.infraData || {}).filter(i => i.country_id === this.country.id && i.type === 'mine').length;
    const mineIncome = calcMineIncome(mines, this.country.pixel_count);
    const hourlyIncome = this.country.income_per_pixel * this.country.pixel_count + mineIncome;
    const pixelUpkeep = Math.max(0, this.country.army_upkeep_per_pixel * this.country.pixel_count);
    const armyUpkeep = this.country.army_size * CONFIG.ARMY_UPKEEP_PER_UNIT;
    const newGold = Math.max(0, Math.round((this.country.gold + (hourlyIncome - pixelUpkeep - armyUpkeep) * hoursOffline) * 10000) / 10000);

    const { data } = await sb.from('countries')
      .update({ pending_pixels: newTokens, gold: newGold, last_active: now.toISOString() })
      .eq('id', this.country.id)
      .select().single();

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
    return Math.min(this.country.pending_pixels + hoursElapsed * CONFIG.PIXELS_PER_HOUR, CONFIG.MAX_STACK);
  }

  getLiveTokens() {
    return Math.floor(this.getLivePending());
  }

  // ── Expansion ────────────────────────────────────────────
  async expandTo(x, y) {
    if (!this.country || this.getLiveTokens() < 1) {
      return { ok: false, msg: 'No expansion tokens available. Come back later!' };
    }

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

    // Combat formula
    const wall = this.infraData[key];
    const wallBonus = wall?.type === 'wall' ? CONFIG.INFRA_COSTS.wall.defenseBonus : 0;
    const terrainDef = (CONFIG.TERRAIN_DEFENSE[pixel.terrain] || 1) * (1 + wallBonus);
    const attackPower = this.country.army_size * (Math.random() * 0.4 + 0.8);
    const defensePower = defender.army_size * terrainDef * (Math.random() * 0.4 + 0.8);

    const success = attackPower > defensePower;
    const attackerLoss = success
      ? Math.ceil(defensePower * 0.3)
      : Math.ceil(attackPower * 0.5);
    const defenderLoss = success
      ? Math.ceil(defensePower * 0.5)
      : Math.ceil(attackPower * 0.2);

    // Apply losses
    const newAttackerArmy = Math.max(1, this.country.army_size - attackerLoss);
    const newDefenderArmy = Math.max(1, defender.army_size - defenderLoss);

    await sb.from('countries').update({ army_size: newAttackerArmy })
      .eq('id', this.country.id);
    await sb.from('countries').update({ army_size: newDefenderArmy })
      .eq('id', defender.id);

    if (success) {
      await sb.from('pixels').update({ country_id: this.country.id, captured_at: new Date().toISOString() })
        .eq('game_id', this.gameId).eq('x', x).eq('y', y);
      await sb.from('countries').update({ pixel_count: this.country.pixel_count + 1 })
        .eq('id', this.country.id);
      await sb.from('countries').update({ pixel_count: Math.max(0, defender.pixel_count - 1) })
        .eq('id', defender.id);

      this.pixelData[key] = { ...pixel, country_id: this.country.id };
      this.country.pixel_count++;

      // 50/50: captured building is either transferred or destroyed
      const capturedInfra = this.infraData[key];
      if (capturedInfra) {
        if (Math.random() < 0.5) {
          // Transfer to attacker
          await sb.from('infrastructure').update({ country_id: this.country.id }).eq('id', capturedInfra.id);
          this.infraData[key] = { ...capturedInfra, country_id: this.country.id };
          // Apply stat effect to attacker
          const infraUpdates = {};
          if (capturedInfra.type === 'farm') infraUpdates.income_per_pixel = this.country.income_per_pixel + CONFIG.INFRA_COSTS.farm.incomeBonus;
          if (capturedInfra.type === 'market') infraUpdates.army_upkeep_per_pixel = Math.max(0.02, this.country.army_upkeep_per_pixel - CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') infraUpdates.army_size = this.country.army_size + CONFIG.INFRA_COSTS.barracks.armyBonus;
          if (Object.keys(infraUpdates).length) {
            await sb.from('countries').update(infraUpdates).eq('id', this.country.id);
            Object.assign(this.country, infraUpdates);
          }
          // Remove stat effect from defender
          const defUpdates = {};
          if (capturedInfra.type === 'farm') defUpdates.income_per_pixel = Math.max(CONFIG.BASE_INCOME_PER_PIXEL, defender.income_per_pixel - CONFIG.INFRA_COSTS.farm.incomeBonus);
          if (capturedInfra.type === 'market') defUpdates.army_upkeep_per_pixel = Math.min(0.3, defender.army_upkeep_per_pixel + CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') defUpdates.army_size = Math.max(1, defender.army_size - CONFIG.INFRA_COSTS.barracks.armyBonus);
          if (Object.keys(defUpdates).length) await sb.from('countries').update(defUpdates).eq('id', defender.id);
        } else {
          // Destroy the building
          await sb.from('infrastructure').delete().eq('id', capturedInfra.id);
          delete this.infraData[key];
          // Remove stat effect from defender
          const defUpdates = {};
          if (capturedInfra.type === 'farm') defUpdates.income_per_pixel = Math.max(CONFIG.BASE_INCOME_PER_PIXEL, defender.income_per_pixel - CONFIG.INFRA_COSTS.farm.incomeBonus);
          if (capturedInfra.type === 'market') defUpdates.army_upkeep_per_pixel = Math.min(0.3, defender.army_upkeep_per_pixel + CONFIG.INFRA_COSTS.market.upkeepReduction);
          if (capturedInfra.type === 'barracks') defUpdates.army_size = Math.max(1, defender.army_size - CONFIG.INFRA_COSTS.barracks.armyBonus);
          if (Object.keys(defUpdates).length) await sb.from('countries').update(defUpdates).eq('id', defender.id);
        }
      }
    }

    this.country.army_size = newAttackerArmy;

    // Log attack
    await sb.from('attacks').insert({
      game_id: this.gameId,
      attacker_id: this.country.id,
      defender_id: defender.id,
      pixel_x: x, pixel_y: y,
      success,
      attacker_losses: attackerLoss,
      defender_losses: defenderLoss,
    });

    const msg = success
      ? `⚔️ Victory! Captured (${x},${y}). Lost ${attackerLoss} troops.`
      : `❌ Failed attack on (${x},${y}). Lost ${attackerLoss} troops.`;
    await this._logEvent('attack', `${this.country.name} attacked ${defender.name} at (${x},${y}) — ${success ? 'SUCCESS' : 'FAILED'}`);

    // Check if defender is eliminated
    const defenderPixelsLeft = Math.max(0, defender.pixel_count - (success ? 1 : 0));
    if (newDefenderArmy <= 1 && defenderPixelsLeft <= 0) {
      await sb.from('countries').update({ is_alive: false, surrendered_at: new Date().toISOString(), pixel_count: defenderPixelsLeft })
        .eq('id', defender.id);
      this.countries[defender.id] = { ...defender, is_alive: false, pixel_count: defenderPixelsLeft, army_size: newDefenderArmy };
      await this._logEvent('eliminated', `${this.country.name} has eliminated ${defender.name}!`);
      await this._checkWinCondition();
    } else {
      this.countries[defender.id] = { ...defender, pixel_count: defenderPixelsLeft, army_size: newDefenderArmy };
    }

    return { ok: true, msg, success, attackerLoss, defenderLoss };
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
    if (this.infraData[key]) {
      return { ok: false, msg: 'A building already stands on this tile.' };
    }
    const buildingCount = Object.values(this.infraData).filter(i => i.country_id === this.country.id).length;
    const buildingCap = Math.floor(this.country.pixel_count / 2);
    if (buildingCount >= buildingCap) {
      return { ok: false, msg: `Building cap reached (${buildingCount}/${buildingCap}). You need ${(buildingCount + 1) * 2} pixels to build more.` };
    }

    const { data: infra, error } = await sb.from('infrastructure').insert({
      country_id: this.country.id,
      game_id: this.gameId,
      type, pixel_x: x, pixel_y: y,
    }).select().single();
    if (error) return { ok: false, msg: error.message };

    this.infraData[key] = infra;

    const newGold = this.country.gold - cost.gold;
    let updates = { gold: newGold };

    if (type === 'barracks') updates.army_size = this.country.army_size + cost.armyBonus;
    if (type === 'farm') updates.income_per_pixel = this.country.income_per_pixel + cost.incomeBonus;
    if (type === 'market') updates.army_upkeep_per_pixel = Math.max(0.02, this.country.army_upkeep_per_pixel - cost.upkeepReduction);
    // mine: ongoing flat income handled by tickIncome; wall: defense bonus handled in attack()

    await sb.from('countries').update(updates).eq('id', this.country.id);
    Object.assign(this.country, updates);

    await this._logEvent('build', `${this.country.name} built a ${type} at (${x},${y})`);
    return { ok: true, msg: `Built ${type}! (${cost.effect})` };
  }

  // ── Trade ─────────────────────────────────────────────────
  async offerTrade(toCountryId, goldAmount) {
    if (this.country.gold < goldAmount) return { ok: false, msg: 'Not enough gold.' };
    const { error } = await sb.from('trades').insert({
      game_id: this.gameId,
      from_country_id: this.country.id,
      to_country_id: toCountryId,
      gold_offered: goldAmount,
    });
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
    if (all.length < 2) return; // need at least 2 nations for a "win"

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
    await sb.channel(`gameover:${this.gameId}`).send({
      type: 'broadcast', event: 'gameover', payload: { winnerName: winner.name, winnerId: winner.player_id, permanent: isAdminCreated }
    });

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
        if (payload.new.player_id === this.playerId) this.country = payload.new;
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
        this.infraData[`${i.pixel_x},${i.pixel_y}`] = i;
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
function calcMineIncome(mines, pixelCount) {
  if (mines === 0) return 0;
  const effectiveFlat = Math.max(0, CONFIG.INFRA_COSTS.mine.flatIncome - (mines - 1) * 0.1);
  const effectivePixelBonus = Math.max(0, CONFIG.INFRA_COSTS.mine.pixelBonus - (mines - 1) * 0.002);
  return mines * effectiveFlat + effectivePixelBonus * pixelCount;
}

async function tickIncome(engine) {
  if (!engine.country) return;
  const c = engine.country;
  const mines = Object.values(engine.infraData || {}).filter(i => i.country_id === c.id && i.type === 'mine').length;
  const mineIncome = calcMineIncome(mines, c.pixel_count);
  const hourlyIncome = c.income_per_pixel * c.pixel_count + mineIncome;
  const pixelUpkeep = Math.max(0, c.army_upkeep_per_pixel * c.pixel_count);
  const armyUpkeep = c.army_size * CONFIG.ARMY_UPKEEP_PER_UNIT;
  const netHourly = hourlyIncome - pixelUpkeep - armyUpkeep;
  const tick = netHourly * (CONFIG.INCOME_TICK_SECONDS / 3600);
  const newGold = Math.max(0, Math.round((c.gold + tick) * 10000) / 10000);
  if (newGold === c.gold) return;

  await sb.from('countries').update({ gold: newGold }).eq('id', c.id);
  engine.country.gold = newGold;
}
