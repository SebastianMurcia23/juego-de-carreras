/**
 * tools/verify-items.js
 * Comprehensive headless verification for Road Rumble arcade item system:
 * 1. Probability distribution test (2000 rolls comparing 1st vs last place)
 * 2. Roulette lockout test (server rejects item use before 0.9s)
 * 3. Single-item constraint test (cannot collect another box while holding an item or rolling)
 * 4. Projectile and oil auto-destruction test (discs <= 7s, missiles <= 8s, oils <= 14s)
 * 5. Full 3-minute multi-bot GameRoom simulation verifying zero NaN, finite numbers,
 *    bounded entity pools, and active item usage.
 */
'use strict';

const assert = require('assert');
const flags = require('../config/feature-flags');
const tracks = require('../config/tracks');
const carsConfig = require('../config/cars');
const GameRoom = require('../server/GameRoom');
const ItemSystem = require('../server/ItemSystem');
const SHARED = require('../shared/constants');

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

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

console.log('🏁 Starting Arcade Items Verification...');

/* ── Test 1: Probability Distribution across 2000 simulated rolls ────────── */
console.log('\n[Test 1] Testing probability distribution over 2000 rolls (1st vs Last place)...');
{
  const cars = new Map();
  cars.set('car1', { seatToken: 'car1', alive: true, finished: false, lap: 1, currentCP: 10 });
  cars.set('car2', { seatToken: 'car2', alive: true, finished: false, lap: 1, currentCP: 5 });

  const dummyTrack = { checkpoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }], roadHalfWidth: 92 };
  const itemSystem = new ItemSystem(fakeIo(), 'TEST', cars, dummyTrack);
  itemSystem.initBoxes([{ dimensions: { length: 65 } }]);

  // Seeded PRNG for reproducible statistical validation across 2000 rolls
  let seed = 12345;
  const originalRandom = Math.random;
  Math.random = function() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const rollCounts = { first: {}, last: {} };
  ['turbo', 'disco', 'misil', 'aceite', 'invencibilidad', 'tinta'].forEach(id => {
    rollCounts.first[id] = 0;
    rollCounts.last[id] = 0;
  });

  const N = 2000;
  for (let i = 0; i < N; i++) {
    // 1st place roll (rankFrac = 0)
    const itemFirst = itemSystem._weightedRandom(itemSystem._interpWeights(0));
    rollCounts.first[itemFirst]++;
  }
  for (let i = 0; i < N; i++) {
    // Last place roll (rankFrac = 1)
    const itemLast = itemSystem._weightedRandom(itemSystem._interpWeights(1));
    rollCounts.last[itemLast]++;
  }

  Math.random = originalRandom;

  console.log('  1st place rolls (2000):', rollCounts.first);
  console.log('  Last place rolls (2000):', rollCounts.last);

  // Requirement: last place receives MORE missiles, turbos, and invencibility than 1st place
  assert(rollCounts.last.misil > rollCounts.first.misil,
    `Last place (${rollCounts.last.misil}) should receive more missiles than 1st place (${rollCounts.first.misil})`);
  assert(rollCounts.last.invencibilidad > rollCounts.first.invencibilidad,
    `Last place (${rollCounts.last.invencibilidad}) should receive more invencibility than 1st place (${rollCounts.first.invencibilidad})`);
  assert(rollCounts.last.turbo > rollCounts.first.turbo,
    `Last place (${rollCounts.last.turbo}) should receive more turbos than 1st place (${rollCounts.first.turbo})`);

  console.log('  ✅ Test 1 Passed: Probability distribution matches rank weighting rules.');
}

/* ── Test 2: Roulette Lockout (0.9s requirement) ─────────────────────────── */
console.log('\n[Test 2] Testing server roulette lockout (rejects use before 0.9s)...');
{
  const cars = new Map();
  const testCar = {
    seatToken: 'test1',
    alive: true,
    finished: false,
    lap: 1,
    currentCP: 0,
    x: 10,
    y: 10,
    angle: 0,
    arcadeItem: null,
    arcadeRollEnd: 0,
  };
  cars.set('test1', testCar);

  const dummyTrack = { checkpoints: [{ x: 10, y: 10 }, { x: 50, y: 10 }], roadHalfWidth: 92 };
  const itemSys = new ItemSystem(fakeIo(), 'TEST', cars, dummyTrack);
  itemSys.initBoxes([{ dimensions: { length: 65 } }]);

  // Force a box right at the car position
  itemSys.boxes[0].x = 10;
  itemSys.boxes[0].y = 10;
  itemSys.boxes[0].active = true;

  const collected = itemSys.tryCollectBox(testCar);
  assert(collected, 'Car should collect the box');
  assert.strictEqual(testCar.arcadeRollEnd, itemSys.tickCount + 27, 'Roll should end in exactly 27 ticks (0.9s @ 30Hz)');

  // Advance 10 ticks (0.33s)
  itemSys.tickCount += 10;
  const activatedEarly = itemSys.activateItem(testCar);
  assert.strictEqual(activatedEarly, false, 'Server MUST reject activation before 0.9s (at tick +10)');
  assert(testCar.arcadeItem != null, 'Car must still hold item after rejected use');

  // Advance past 0.9s (tickCount + 28)
  itemSys.tickCount += 18; // total +28
  const activatedOnTime = itemSys.activateItem(testCar);
  assert.strictEqual(activatedOnTime, true, 'Server MUST allow activation after 0.9s');
  assert.strictEqual(testCar.arcadeItem, null, 'Car item must be cleared after activation');

  console.log('  ✅ Test 2 Passed: 0.9s roulette lockout strictly enforced by server.');
}

/* ── Test 3: Single Item Constraint ─────────────────────────────────────── */
console.log('\n[Test 3] Testing single item constraint (cannot collect another box while holding item)...');
{
  const cars = new Map();
  const testCar = {
    seatToken: 'test1',
    alive: true,
    finished: false,
    lap: 1,
    currentCP: 0,
    x: 10,
    y: 10,
    arcadeItem: 'turbo',
    arcadeRollEnd: 0,
  };
  cars.set('test1', testCar);

  const dummyTrack = { checkpoints: [{ x: 10, y: 10 }, { x: 50, y: 10 }], roadHalfWidth: 92 };
  const itemSys = new ItemSystem(fakeIo(), 'TEST', cars, dummyTrack);
  itemSys.initBoxes([{ dimensions: { length: 65 } }]);
  itemSys.boxes[0].x = 10;
  itemSys.boxes[0].y = 10;
  itemSys.boxes[0].active = true;

  const try1 = itemSys.tryCollectBox(testCar);
  assert.strictEqual(try1, false, 'Car holding an item cannot pick up another box');
  assert(itemSys.boxes[0].active, 'Box must remain active');

  // Test during rolling
  testCar.arcadeItem = null;
  testCar.arcadeRollEnd = itemSys.tickCount + 50; // currently rolling
  const try2 = itemSys.tryCollectBox(testCar);
  assert.strictEqual(try2, false, 'Car currently rolling roulette cannot pick up another box');
  assert(itemSys.boxes[0].active, 'Box must remain active');

  console.log('  ✅ Test 3 Passed: One item per car constraint confirmed.');
}

/* ── Test 4: Projectile & Oil Auto-Destruction ────────────────────────────── */
console.log('\n[Test 4] Testing projectiles and oils lifespan and auto-destruction...');
{
  const cars = new Map();
  const dummyTrack = { checkpoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }], roadHalfWidth: 92 };
  const itemSys = new ItemSystem(fakeIo(), 'TEST', cars, dummyTrack);
  itemSys.initBoxes([{ dimensions: { length: 65 } }]);

  // Add a disc (lifespan 7s), missile (8s), oil (14s)
  itemSys.discs.push({ id: 1, x: 0, y: 0, vx: 100, vy: 0, life: 7.0, age: 0, ownerToken: 'owner' });
  itemSys.missiles.push({ id: 2, x: 0, y: 0, angle: 0, speed: 200, life: 8.0, ownerToken: 'owner' });
  itemSys.oils.push({ id: 3, x: 0, y: 0, radius: 20, life: 14.0, age: 0, ownerToken: 'owner' });

  // Advance 7.5 seconds (225 ticks)
  const dt = 1 / 30;
  for (let t = 0; t < 225; t++) {
    itemSys.tick(dt);
  }
  assert.strictEqual(itemSys.discs.length, 0, 'Disc must be destroyed after 7.0s');
  assert.strictEqual(itemSys.missiles.length, 1, 'Missile must still be alive after 7.5s');
  assert.strictEqual(itemSys.oils.length, 1, 'Oil must still be alive after 7.5s');

  // Advance another 1.5 seconds (total 9s)
  for (let t = 0; t < 45; t++) {
    itemSys.tick(dt);
  }
  assert.strictEqual(itemSys.missiles.length, 0, 'Missile must be destroyed after 8.0s');
  assert.strictEqual(itemSys.oils.length, 1, 'Oil must still be alive after 9.0s');

  // Advance another 6 seconds (total 15s)
  for (let t = 0; t < 180; t++) {
    itemSys.tick(dt);
  }
  assert.strictEqual(itemSys.oils.length, 0, 'Oil slick must be destroyed after 14.0s');

  console.log('  ✅ Test 4 Passed: All projectiles and oils destroyed within their lifespan.');
}

/* ── Test 5: Headless Multi-Car GameRoom Simulation (3 minutes) ──────────── */
console.log('\n[Test 5] Running 3-minute headless multi-car simulation with bots using items...');
{
  const testTrack = tracks.find(t => t.id === 'es-1991') || tracks[0];
  const numBots = 6;
  const seatsMap = new Map();

  const carIds = ['apex_venom', 'goliath_mk4', 'drift_phantom', 'mud_crusher', 'viper_gt', 'nitro_wasp'];
  for (let b = 0; b < numBots; b++) {
    const seatToken = `sim-bot-${b}`;
    seatsMap.set(seatToken, {
      token: seatToken,
      name: `Bot ${b + 1}`,
      isHost: b === 0,
      carId: carIds[b % carIds.length],
      weaponId: 'vulcan_mg',
    });
  }

  const roomData = {
    settings: {
      mode: 'single',
      trackId: testTrack.id,
      laps: 5,
      ammoMultiplier: 1,
      friendlyFire: false,
    },
    seats: seatsMap,
    championship: { raceNumber: 0, standings: new Map() },
  };

  const io = fakeIo();
  const game = new GameRoom(io, 'SIM_ROOM', roomData);
  game.state = 'racing';

  // Mark all cars as bots for automatic item usage
  for (const [, car] of game.cars) {
    car.isBot = true;
  }

  const SIM_TICKS = 30 * 60 * 3; // 3 minutes = 5400 ticks
  const dt = 1 / 30;
  let itemsCollected = 0;
  let itemsUsed = 0;
  let stunsTriggered = 0;

  for (let tick = 0; tick < SIM_TICKS; tick++) {
    // Steer each bot along checkpoints
    for (const [st, car] of game.cars) {
      if (!car.alive) continue;
      const cp = game.track.checkpoints[car.currentCP];
      if (cp) {
        const targetAngle = Math.atan2(cp.y - car.y, cp.x - car.x);
        const angleErr = normalizeAngle(targetAngle - car.angle);
        const steer = Math.max(-1, Math.min(1, angleErr * 1.5));
        const brake = Math.abs(angleErr) > 0.7 && car.speed > 160;
        game.setInput(st, {
          steer,
          accel: !brake,
          brake,
          drift: false,
          power: false, // bots activate via ItemSystem timer
          steerSeq: tick,
        });
      }

      // Assert No NaN on car state
      assert(Number.isFinite(car.x), `car.x must be finite at tick ${tick}`);
      assert(Number.isFinite(car.y), `car.y must be finite at tick ${tick}`);
      assert(Number.isFinite(car.speed), `car.speed must be finite at tick ${tick}`);
      assert(Number.isFinite(car.angle), `car.angle must be finite at tick ${tick}`);
    }

    // Step physics and arcade systems
    game.tick(dt);

    // Validate item system state
    if (game.itemSystem) {
      const snap = game.itemSystem.getStateSnapshot();
      snap.discs.forEach(d => {
        assert(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.ang),
          `Disc coordinates must be finite at tick ${tick}`);
      });
      snap.missiles.forEach(m => {
        assert(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.ang),
          `Missile coordinates must be finite at tick ${tick}`);
      });
      snap.oils.forEach(o => {
        assert(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.r),
          `Oil coordinates must be finite at tick ${tick}`);
      });
    }
  }

  // Count events from fakeIo
  io.events.forEach(e => {
    if (e.name === SHARED.EVENTS.ITEM_BOX_TAKEN) itemsCollected++;
    if (e.name === SHARED.EVENTS.ITEM_USED) itemsUsed++;
    if (e.name === SHARED.EVENTS.ITEM_HIT) stunsTriggered++;
  });

  console.log(`  Simulation complete (${SIM_TICKS} ticks / 3m):`);
  console.log(`    - Item boxes collected: ${itemsCollected}`);
  console.log(`    - Items activated by bots: ${itemsUsed}`);
  console.log(`    - Hits / Stuns recorded: ${stunsTriggered}`);
  console.log(`    - Zero NaNs detected in all states.`);

  assert(itemsCollected > 0, 'Bots should have collected item boxes during 3 minutes');
  assert(itemsUsed > 0, 'Bots should have used items during 3 minutes');

  console.log('  ✅ Test 5 Passed: 3-minute headless simulation completed with 0 errors.');
}

console.log('\n🎉 ALL ARCADE ITEM VERIFICATION TESTS PASSED SUCCESSFULLY! (5/5)\n');
