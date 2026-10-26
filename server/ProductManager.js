'use strict';

const { v4: uuidv4 } = require('uuid');
const { COSMETICS, MISSIONS, SEASON } = require('../config/product');

class ProductManager {
  constructor() {
    this.profiles = new Map();
    this.leaderboard = new Map();
  }

  _profile(id) {
    if (!id || typeof id !== 'string' || id.length > 80) return null;
    if (!this.profiles.has(id)) {
      this.profiles.set(id, {
        id, name: 'Piloto', xp: 0, level: 1, coins: 500, gems: 0,
        premium: false, inventory: ['skin-neon-cyan'], claimed: [],
        missions: Object.fromEntries(MISSIONS.map(m => [m.id, 0])),
        stats: { races: 0, wins: 0, podiums: 0, kills: 0 },
      });
    }
    return this.profiles.get(id);
  }

  getProfile(id) {
    const profile = this._profile(id);
    return profile ? { ...profile, stats: { ...profile.stats }, inventory: [...profile.inventory] } : null;
  }

  upsertProfile(id, name) {
    const profile = this._profile(id || uuidv4());
    if (name && typeof name === 'string') profile.name = name.trim().slice(0, 20) || profile.name;
    return this.getProfile(profile.id);
  }

  catalog() {
    return { cosmetics: COSMETICS, missions: MISSIONS, season: SEASON, paymentProvider: process.env.PAYMENT_PROVIDER || null };
  }

  purchase(id, cosmeticId) {
    const profile = this._profile(id);
    const item = COSMETICS.find(c => c.id === cosmeticId);
    if (!profile || !item) return { error: 'NOT_FOUND' };
    if (profile.inventory.includes(item.id)) return { error: 'ALREADY_OWNED' };
    if (profile.coins < item.price) return { error: 'INSUFFICIENT_FUNDS' };
    profile.coins -= item.price;
    profile.inventory.push(item.id);
    return this.getProfile(id);
  }

  grantRaceResult(id, result) {
    const profile = this._profile(id);
    if (!profile) return null;
    profile.stats.races++;
    if (result.place === 1) profile.stats.wins++;
    if (result.place && result.place <= 3) profile.stats.podiums++;
    profile.stats.kills += Math.max(0, Number(result.kills) || 0);
    profile.coins += result.place === 1 ? 180 : result.place <= 3 ? 120 : 70;
    profile.xp += result.place === 1 ? 250 : result.place <= 3 ? 160 : 100;
    profile.level = Math.floor(profile.xp / 500) + 1;
    return this.getProfile(id);
  }

  leaderboardTop(limit = 25) {
    return [...this.profiles.values()]
      .sort((a, b) => b.xp - a.xp)
      .slice(0, Math.min(50, Math.max(1, limit)))
      .map((p, index) => ({ rank: index + 1, id: p.id, name: p.name, level: p.level, xp: p.xp, wins: p.stats.wins }));
  }
}

module.exports = ProductManager;
