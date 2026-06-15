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
  async load() {
    const [gameRes, countryRes, pixelsRes, countriesRes, infraRes] = await Promise.all([
      sb.from('games').select('*').eq('id', this.gameId).single(),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('player_id', this.playerId).single(),
      sb.from('pixels').select('*').eq('game_id', this.gameId),
      sb.from('countries').select('*').eq('game_id', this.gameId).eq('is_alive', true),
      sb.from('infrastructure').select('*').eq('game_id', this.gameId),
    ]);

    this.game = gameRes.data;
    this.country = countryRes.data;

    // Index pixel data
    (pixelsRes.data || []).forEach(p => {
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
    }

    return this;
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

    const { data } = await sb.from('countries')
      .update({ pending_pixels: newTokens, last_active: now.toISOString() })
      .eq('id', this.country.id)
      .select().single();

    if (data) this.country = data;
  }

  // How many whole expansion tokens available
  get expansionTokens() {
    return this.country ? Math.floor(this.country.pending_pixels) : 0;
  }

  // ── Expansion ────────────────────────────────────────────
  async expandTo(x, y) {
    if (!this.country || this.expansionTokens < 1) {
      return { ok: false, msg: 'No expansion tokens available. Come back later!' };
    }

    const key = `${x},${y}`;
    const pixel = this.pixelData[key];
    if (!pixel) return { ok: false, msg: 'Pixel not found.' };
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

    const newPending = this.country.pending_pixels - 1;
    const newCount = this.country.pixel_count + 1;
    const { data: updatedCountry } = await sb.from('countries')
      .update({ pending_pixels: newPending, pixel_count: newCount })
      .eq('id', this.country.id).select().single();

    if (updatedCountry) this.country = updatedCountry;
    this.pixelData[key] = { ...pixel, country_id: this.country.id };

    await this._logEvent('expand', `${this.country.name} expanded to (${x},${y})`);
    return { ok: true, msg: `Expanded! Tokens left: ${this.expansionTokens}` };
  }

  // ── Combat ────────────────────────────────────────────────
  async attack(x, y) {
    if (!this.country) return { ok: false, msg: 'No country.' };

    const goldCost = CONFIG.ATTACK_GOLD_COST;
    if (this.country.gold < goldCost) {
      return { ok: false, msg: `Not enough gold. Need ${goldCost}.` };
    }

    const key = `${x},${y}`;
    const pixel = this.pixelData[key];
    if (!pixel || !pixel.country_id) return { ok: false, msg: 'No enemy here.' };
    if (pixel.country_id === this.country.id) return { ok: false, msg: 'That is already yours.' };
    if (!this._adjacentToOwn(x, y)) return { ok: false, msg: 'Must attack adjacent tiles.' };

    const defender = this.countries[pixel.country_id];
    if (!defender) return { ok: false, msg: 'Defender not found.' };

    // Combat formula
    const terrainDef = CONFIG.TERRAIN_DEFENSE[pixel.terrain] || 1;
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
    const newGold = this.country.gold - goldCost;

    await sb.from('countries').update({ army_size: newAttackerArmy, gold: newGold })
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
    }

    this.country.army_size = newAttackerArmy;
    this.country.gold = newGold;

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
    if (newDefenderArmy <= 1 && defender.pixel_count <= 1) {
      await sb.from('countries').update({ is_alive: false, surrendered_at: new Date().toISOString() })
        .eq('id', defender.id);
      await this._logEvent('eliminated', `${this.country.name} has eliminated ${defender.name}!`);
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

    const { data: infra, error } = await sb.from('infrastructure').insert({
      country_id: this.country.id,
      game_id: this.gameId,
      type, pixel_x: x, pixel_y: y,
    }).select().single();
    if (error) return { ok: false, msg: error.message };

    this.infraData[key] = infra;

    const newGold = this.country.gold - cost.gold;
    let updates = { gold: newGold };

    if (type === 'barracks') updates.army_size = this.country.army_size + 20;
    if (type === 'farm') updates.income_per_pixel = this.country.income_per_pixel + 0.5;
    if (type === 'mine') updates.gold = newGold + 10; // instant bonus

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

  destroy() {
    this.realtimeSubs.forEach(s => sb.removeChannel(s));
  }
}

// ── Income ticker (runs client-side every minute) ─────────
async function tickIncome(engine) {
  if (!engine.country) return;
  const c = engine.country;
  const minuteIncome = (c.income_per_pixel * c.pixel_count) / 60;
  const newGold = Math.floor(c.gold + minuteIncome);
  if (newGold === c.gold) return;

  await sb.from('countries').update({ gold: newGold }).eq('id', c.id);
  engine.country.gold = newGold;
}
