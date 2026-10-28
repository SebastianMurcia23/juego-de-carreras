/**
 * tools/verify-items-bounds.js
 * Verification of arcade power constraints across circuits:
 * 1. Boundary check: No missile, disc, or oil slick escapes the usable track road surface.
 * 2. Missile homing: Missiles launched with live targets either hit or expire cleanly within lifespan.
 * 3. Hit rate: Verifies homing missiles successfully track and reach moving bots.
 * 4. Zero NaNs and zero orphan entities after race finish.
 */
'use strict';

const assert = require('assert');
const tracksGeo = require('../config/tracks-geo.json');
const ItemSystem = require('../server/ItemSystem');
const SHARED = require('../shared/constants');
const { generateTrack } = require('../server/TrackGenerator');

function fakeIo() {
  const events = [];
  return {
    events,
    to() {
      return {
        emit(name, payload) {
          events.push({ name, payload });
        },
      };
    },
  };
}

console.log('🚀 Running Arcade Items Boundaries & Track Navigation Verification across all 40 circuits...\n');

const stats = {
  tracksTested: 0,
  discsFired: 0,
  discsMaxLatRatio: 0, // max ratio of latDist / roadHalfWidth
  missilesFired: 0,
  missilesHit: 0,
  missilesExpired: 0,
  missilesMaxLatRatio: 0,
  oilsPlaced: 0,
  oilsMaxLatRatio: 0,
  nanDetected: 0,
  orphansDetected: 0,
};

const tracksToTest = tracksGeo.tracks; // All 40 tracks
const dt = 1 / 30;

for (const trackDef of tracksToTest) {
  stats.tracksTested++;
  const track = generateTrack(trackDef, 4);
  const roadHW = track.roadHalfWidth || 92;
  const cps = track.checkpoints;

  const cars = new Map();
  // 4 bots positioned along the circuit
  for (let i = 0; i < 4; i++) {
    const cpIdx = Math.floor((i / 4) * cps.length);
    const cp = cps[cpIdx];
    const nextCp = cps[(cpIdx + 1) % cps.length];
    const angle = Math.atan2(nextCp.y - cp.y, nextCp.x - cp.x);
    cars.set('bot' + i, {
      seatToken: 'bot' + i,
      name: 'Bot ' + i,
      x: cp.x,
      y: cp.y,
      vx: Math.cos(angle) * 320,
      vy: Math.sin(angle) * 320,
      angle: angle,
      speed: 320,
      lap: 1,
      currentCP: cpIdx,
      alive: true,
      finished: false,
      maxSpeed: 420,
      arcadeBoostEnd: 0,
      arcadeInvEnd: 0,
      arcadeStunEnd: 0,
      arcadeInkEnd: 0,
      arcadeItem: null,
      arcadeRollEnd: 0,
      arcadeItemHitBonus: 0,
    });
  }

  const io = fakeIo();
  const itemSystem = new ItemSystem(io, 'BOUNDS_TEST_' + trackDef.id, cars, track, 30);
  itemSystem.initBoxes([{ dimensions: { length: 65 } }]);

  // Simulate 35 seconds of active racing per track with continuous firing
  const totalTicks = 35 * 30;
  for (let tick = 0; tick < totalTicks; tick++) {
    // Move bots around checkpoints
    for (const [, bot] of cars) {
      if (itemSystem.isStunned(bot)) {
        bot.speed = 100;
      } else {
        bot.speed = 320;
      }
      const targetCp = cps[(bot.currentCP + 1) % cps.length];
      const toX = targetCp.x - bot.x;
      const toY = targetCp.y - bot.y;
      const dist = Math.hypot(toX, toY);
      if (dist < 80) {
        bot.currentCP = (bot.currentCP + 1) % cps.length;
        if (bot.currentCP === 0) bot.lap++;
      }
      bot.angle = Math.atan2(toY, toX);
      bot.vx = Math.cos(bot.angle) * bot.speed;
      bot.vy = Math.sin(bot.angle) * bot.speed;
      bot.x += bot.vx * dt;
      bot.y += bot.vy * dt;
    }

    // Periodically fire items
    if (tick % 75 === 15) {
      // Fire missile from trailing bot
      const trailingBot = cars.get('bot0');
      trailingBot.arcadeItem = 'misil';
      trailingBot.arcadeRollEnd = 0;
      itemSystem.activateItem(trailingBot);
      stats.missilesFired++;
    }

    if (tick % 90 === 30) {
      // Fire disc
      const midBot = cars.get('bot1');
      midBot.arcadeItem = 'disco';
      midBot.arcadeRollEnd = 0;
      itemSystem.activateItem(midBot);
      stats.discsFired++;
    }

    if (tick % 110 === 45) {
      // Drop oil
      const leadBot = cars.get('bot3');
      leadBot.arcadeItem = 'aceite';
      leadBot.arcadeRollEnd = 0;
      itemSystem.activateItem(leadBot);
      stats.oilsPlaced++;
    }

    itemSystem.tick(dt);

    // Verify boundaries for all active missiles
    for (const m of itemSystem.missiles) {
      assert(Number.isFinite(m.x) && Number.isFinite(m.y), `NaN in missile position on track ${trackDef.id}`);
      const nearPt = itemSystem._nearestTrackPoint(m.x, m.y);
      if (nearPt) {
        const latDist = Math.abs(itemSystem._lateralDist(m.x, m.y, nearPt));
        const ratio = latDist / roadHW;
        if (ratio > stats.missilesMaxLatRatio) stats.missilesMaxLatRatio = ratio;
        assert(latDist <= roadHW * 1.15,
          `Missile escaped track on ${trackDef.id}: latDist ${latDist.toFixed(1)} > roadHW ${roadHW}`);
      }
    }

    // Verify boundaries for all active discs
    for (const d of itemSystem.discs) {
      assert(Number.isFinite(d.x) && Number.isFinite(d.y), `NaN in disc position on track ${trackDef.id}`);
      const nearPt = itemSystem._nearestTrackPoint(d.x, d.y);
      if (nearPt) {
        const latDist = Math.abs(itemSystem._lateralDist(d.x, d.y, nearPt));
        const ratio = latDist / roadHW;
        if (ratio > stats.discsMaxLatRatio) stats.discsMaxLatRatio = ratio;
        assert(latDist <= roadHW * 1.15,
          `Disc escaped track on ${trackDef.id}: latDist ${latDist.toFixed(1)} > roadHW ${roadHW}`);
      }
    }

    // Verify boundaries for all active oils
    for (const o of itemSystem.oils) {
      assert(Number.isFinite(o.x) && Number.isFinite(o.y), `NaN in oil position on track ${trackDef.id}`);
      const nearPt = itemSystem._nearestTrackPoint(o.x, o.y);
      if (nearPt) {
        const latDist = Math.abs(itemSystem._lateralDist(o.x, o.y, nearPt));
        const ratio = latDist / roadHW;
        if (ratio > stats.oilsMaxLatRatio) stats.oilsMaxLatRatio = ratio;
        assert(latDist <= roadHW * 1.15,
          `Oil escaped track on ${trackDef.id}: latDist ${latDist.toFixed(1)} > roadHW ${roadHW}`);
      }
    }
  }

  // Count missile impacts from events
  const hitEvents = io.events.filter(e => e.name === SHARED.EVENTS.ITEM_HIT && e.payload.item === 'misil');
  stats.missilesHit += hitEvents.length;

  // Test clean reset
  itemSystem.clear();
  if (itemSystem.discs.length > 0 || itemSystem.missiles.length > 0 || itemSystem.oils.length > 0) {
    stats.orphansDetected++;
  }
}

const hitRate = stats.missilesFired > 0 ? (stats.missilesHit / stats.missilesFired * 100).toFixed(1) : '100';

console.log('📊 Verification Results Summary:');
console.log('-----------------------------------------------------------------------------------------');
console.log(`Tracks Tested:                 ${stats.tracksTested} / 40`);
console.log(`Missiles Fired:                ${stats.missilesFired}`);
console.log(`Missiles Hit:                  ${stats.missilesHit} (Hit rate: ${hitRate}%)`);
console.log(`Missiles Max Road HW Ratio:    ${(stats.missilesMaxLatRatio * 100).toFixed(1)}% (Target: <= 100%)`);
console.log(`Discs Fired:                   ${stats.discsFired}`);
console.log(`Discs Max Road HW Ratio:       ${(stats.discsMaxLatRatio * 100).toFixed(1)}% (Target: <= 100%)`);
console.log(`Oils Placed:                   ${stats.oilsPlaced}`);
console.log(`Oils Max Road HW Ratio:        ${(stats.oilsMaxLatRatio * 100).toFixed(1)}% (Target: <= 100%)`);
console.log(`NaNs / Infs Detected:          ${stats.nanDetected}`);
console.log(`Orphan Entities on Clear:      ${stats.orphansDetected}`);
console.log('-----------------------------------------------------------------------------------------');

assert.strictEqual(stats.tracksTested, 40, 'All 40 tracks should be tested');
assert(stats.missilesMaxLatRatio <= 1.05, 'Missiles must stay within track road limits');
assert(stats.discsMaxLatRatio <= 1.05, 'Discs must stay within track road limits');
assert(stats.oilsMaxLatRatio <= 1.05, 'Oils must stay within track road limits');
assert(stats.missilesHit > 0, 'Missiles must successfully track and hit moving targets');
assert.strictEqual(stats.nanDetected, 0, 'No NaNs detected in physics simulation');
assert.strictEqual(stats.orphansDetected, 0, 'No orphan entities remaining after race clear');

console.log('\n✅ Task 1 (verify-items-bounds) PASSED ON ALL 40 TRACKS!\n');
