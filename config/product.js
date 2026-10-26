'use strict';

const COSMETICS = [
  { id: 'skin-neon-cyan', type: 'skin', name: 'Neon Cyan', rarity: 'rare', price: 250, color: '#00f5d4' },
  { id: 'skin-solar-flare', type: 'skin', name: 'Solar Flare', rarity: 'epic', price: 500, color: '#ff7b00' },
  { id: 'skin-void-purple', type: 'skin', name: 'Void Purple', rarity: 'legendary', price: 900, color: '#9b5cff' },
  { id: 'trail-pink-comet', type: 'trail', name: 'Pink Comet', rarity: 'epic', price: 650, color: '#f72585' },
  { id: 'badge-champion', type: 'badge', name: 'Champion', rarity: 'legendary', price: 1200, color: '#ffd166' },
];

const MISSIONS = [
  { id: 'daily-race', name: 'Piloto diario', description: 'Termina 1 carrera', goal: 1, rewardXp: 120, rewardCoins: 80 },
  { id: 'daily-speed', name: 'A fondo', description: 'Alcanza 250 km/h', goal: 250, rewardXp: 180, rewardCoins: 120 },
  { id: 'weekly-winner', name: 'Podio semanal', description: 'Termina en el podio 3 veces', goal: 3, rewardXp: 600, rewardCoins: 400 },
];

const SEASON = {
  id: 'season-01-launch',
  name: 'Temporada Launch',
  endsAt: '2027-01-31T23:59:59.000Z',
  rewards: [
    { level: 1, free: { type: 'coins', amount: 150 }, premium: { type: 'coins', amount: 300 } },
    { level: 2, free: { type: 'cosmetic', id: 'skin-neon-cyan' }, premium: { type: 'cosmetic', id: 'trail-pink-comet' } },
    { level: 3, free: { type: 'coins', amount: 300 }, premium: { type: 'cosmetic', id: 'skin-solar-flare' } },
  ],
};

module.exports = { COSMETICS, MISSIONS, SEASON };
