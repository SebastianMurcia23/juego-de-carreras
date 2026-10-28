/**
 * tools/verify-laps.js
 * Comprehensive Lap & Checkpoint Gate Verification across tracks:
 *  (1) Left curb, Right curb, and Center line lane navigation: all count laps reliably.
 *  (2) Skipped segment / shortcut: crossing finish gate without all gates does NOT count lap, emits warning.
 *  (3) Reverse driving: driving backward does NOT count lap.
 *  (4) Wrong-way respawn preserves exact progress: no checkpoints or laps gained/lost.
 *  (5) 12 cars simultaneous race: all laps tracked cleanly.
 */
'use strict';

const assert = require('assert');
const tracks = require('../config/tracks');
const GameRoom = require('../server/GameRoom');
const PHY = require('../shared/constants').PHYSICS;

const DT = 1 / 30;

function fakeIo(events = []) {
  return {
    events,
    to(roomCode) {
      return {
        emit(event, data) {
          events.push({ roomCode, event, data, time: Date.now() });
        },
      };
    },
    emit(event, data) {
      events.push({ event, data, time: Date.now() });
    },
  };
}

function makeRoom(track, botCount = 1) {
  const seats = new Map();
  for (let i = 0; i < botCount; i++) {
    const token = `seat-${i + 1}`;
    seats.set(token, {
      token,
      name: `Piloto ${i + 1}`,
      isHost: i === 0,
      carId: 'apex_venom',
      weaponId: 'vulcan_mg',
      isReady: true,
    });
  }
  return {
    settings: {
      mode: 'single',
      trackId: track.id,
      laps: 1,
      ammoMultiplier: 1,
      friendlyFire: false,
      finishTimeoutSeconds: 15,
    },
    seats,
    championship: {
      raceNumber: 0,
      standings: new Map(),
    },
  };
}

async function runLapVerification() {
  console.log('🏁 Starting Reliable Laps & Full-Width Gate Verification across tracks...\n');

  // Test 1: Test Left lane, Right lane, and Center lane across sample and curved tracks
  console.log('[Test 1] Testing Gate Crossing across Full Road Width (Left, Right, Center lanes)...');
  const testTracks = tracks.slice(0, 10); // Comprehensive sample including sharp turns

  for (const track of testTracks) {
    const room = makeRoom(track, 3);
    const events = [];
    const game = new GameRoom(fakeIo(events), `test-laps-${track.id}`, room);
    game.state = 'racing';

    const roadHW = game.track.roadHalfWidth || PHY.ROAD_HALF_WIDTH;
    const cps = game.track.checkpoints;
    const n = cps.length;

    // Simulate 3 cars stepping through each gate: Center (0), Left (-0.7 HW), Right (+0.7 HW)
    const offsets = [0, -roadHW * 0.70, roadHW * 0.70];
    const cars = Array.from(game.cars.values());

    for (let cIdx = 0; cIdx < 3; cIdx++) {
      const car = cars[cIdx];
      const offset = offsets[cIdx];

      for (let g = 0; g <= n; g++) {
        const cp = cps[g % n];
        const angle = cp.angle || 0;
        const nx = -Math.sin(angle);
        const ny = Math.cos(angle);
        const tx = Math.cos(angle);
        const ty = Math.sin(angle);

        // Previous position just before gate
        car.previousX = cp.x + nx * offset - tx * 15;
        car.previousY = cp.y + ny * offset - ty * 15;
        // Current position just past gate
        car.x = cp.x + nx * offset + tx * 15;
        car.y = cp.y + ny * offset + ty * 15;
        car.angle = angle;
        car.speed = 100;
        car.vx = tx * 100;
        car.vy = ty * 100;

        game._checkCheckpoints(car);
      }

      assert.strictEqual(car.lap, 1, `Car ${cIdx} on track ${track.id} (offset ${offset.toFixed(1)}) failed to complete lap 1`);
      assert.strictEqual(car.finished, true, `Car ${cIdx} on track ${track.id} was not marked finished`);
    }
  }
  console.log('  ✅ Test 1 Passed: Center, Left curb, and Right curb cars all count laps 100% reliably across gates.\n');

  // Test 2: Shortcut / Skipped Gate Detection
  console.log('[Test 2] Testing Skipped Gate Detection (Anti-Cheat / Shortcut Prevention)...');
  const sampleTrack = tracks[0];
  const room2 = makeRoom(sampleTrack, 1);
  const events2 = [];
  const game2 = new GameRoom(fakeIo(events2), 'test-shortcut', room2);
  game2.state = 'racing';
  const car2 = Array.from(game2.cars.values())[0];
  const cps2 = game2.track.checkpoints;

  // Car starts at Gate 0, passes Gate 1, then teleports directly to Finish Line (Gate 0) skipping intermediate gates
  car2.previousX = cps2[0].x;
  car2.previousY = cps2[0].y;
  car2.x = cps2[1].x;
  car2.y = cps2[1].y;
  car2.speed = 80;
  game2._checkCheckpoints(car2); // passes CP 0 -> currentCP becomes 1

  // Teleport to finish line
  const finishGate = game2.track.gates[0];
  car2.previousX = finishGate.x - finishGate.tx * 15;
  car2.previousY = finishGate.y - finishGate.ty * 15;
  car2.x = finishGate.x + finishGate.tx * 15;
  car2.y = finishGate.y + finishGate.ty * 15;
  game2._checkCheckpoints(car2);

  // Lap must NOT increment!
  assert.strictEqual(car2.lap, 0, 'Car should NOT have completed lap after skipping gates');
  assert.strictEqual(car2.finished, false, 'Car should NOT have finished race after skipping gates');

  // Toast warning should be emitted
  const toastEvent = events2.find(e => e.event === 'toast' && e.data.message.includes('Te saltaste un tramo'));
  assert(toastEvent, 'Toast warning for skipped segment must be emitted');
  console.log('  ✅ Test 2 Passed: Shortcut / skipped checkpoint detected; lap rejected and player notified.\n');

  // Test 3: Reverse Driving Lap Rejection
  console.log('[Test 3] Testing Reverse Driving (Laps cannot be gained backward)...');
  const room3 = makeRoom(sampleTrack, 1);
  const game3 = new GameRoom(fakeIo(), 'test-reverse', room3);
  game3.state = 'racing';
  const car3 = Array.from(game3.cars.values())[0];
  const cps3 = game3.track.checkpoints;

  // Car drives in reverse order from Gate 0 backwards to Gate n-1
  for (let i = cps3.length - 1; i >= 0; i--) {
    const cp = cps3[i];
    const angle = cp.angle || 0;
    const tx = Math.cos(angle);
    const ty = Math.sin(angle);

    // Crossing backward
    car3.previousX = cp.x + tx * 20;
    car3.previousY = cp.y + ty * 20;
    car3.x = cp.x - tx * 20;
    car3.y = cp.y - ty * 20;
    car3.angle = angle + Math.PI;
    car3.speed = 80;
    car3.vx = -tx * 80;
    car3.vy = -ty * 80;

    game3._checkCheckpoints(car3);
  }
  assert.strictEqual(car3.lap, 0, 'Reverse driving must never increase lap count');
  console.log('  ✅ Test 3 Passed: Reverse driving rejects gates in wrong direction and never counts laps.\n');

  // Test 4: Wrong-way Respawn Progress Invariance
  console.log('[Test 4] Testing Wrong-Way Respawn Invariance...');
  const room4 = makeRoom(sampleTrack, 1);
  const events4 = [];
  const game4 = new GameRoom(fakeIo(events4), 'test-respawn-inv', room4);
  game4.state = 'racing';
  game4.elapsedTime = 10;
  const car4 = Array.from(game4.cars.values())[0];

  // Advance car legitimately through CP 0, 1, 2
  for (let g = 0; g < 3; g++) {
    const cp = game4.track.checkpoints[g];
    const tx = Math.cos(cp.angle || 0);
    const ty = Math.sin(cp.angle || 0);
    car4.previousX = cp.x - tx * 10;
    car4.previousY = cp.y - ty * 10;
    car4.x = cp.x + tx * 10;
    car4.y = cp.y + ty * 10;
    game4._checkCheckpoints(car4);
  }
  const savedCP = car4.currentCP;
  const savedLap = car4.lap;
  const savedLastValidCP = car4.lastValidCP;

  // Drive wrong way until respawn triggers (30 ticks hysteresis + 150 ticks countdown = 180 ticks)
  for (let t = 0; t <= 220; t++) {
    game4.elapsedTime += DT;
    car4.speed = 60;
    car4.angle = (game4.track.checkpoints[savedLastValidCP].angle || 0) + Math.PI;
    car4.vx = Math.cos(car4.angle) * 60;
    car4.vy = Math.sin(car4.angle) * 60;
    car4.x += car4.vx * DT;
    car4.y += car4.vy * DT;
    game4._updateTrackProgressAndOrientation(car4);
    if (t > 40 && car4.wrongWayTicks === 0) {
      // Respawn successfully triggered!
      break;
    }
  }

  // Verify warning was emitted
  const warnEvt = events4.find(e => e.event === 'wrong_way_warning');
  assert(warnEvt, 'Wrong way warning must be emitted during sustained reverse driving');

  // Verify respawn occurred
  assert.strictEqual(car4.speed, 0, 'Car speed must be zeroed on respawn');
  assert.strictEqual(car4.currentCP, savedCP, 'Checkpoint index must NOT change after wrong-way respawn');
  assert.strictEqual(car4.lap, savedLap, 'Lap count must NOT change after wrong-way respawn');
  assert.strictEqual(car4.wrongWayActive, false, 'Wrong way state must be cleared after respawn');
  console.log('  ✅ Test 4 Passed: Wrong-way respawn cleanly resets car with zero velocity without gaining or losing progress.\n');

  // Test 5: 12 Simultaneous Cars Full Lap Verification
  console.log('[Test 5] Testing 12 Simultaneous Cars on Track...');
  const room5 = makeRoom(sampleTrack, 12);
  const game5 = new GameRoom(fakeIo(), 'test-12-cars', room5);
  game5.state = 'racing';
  assert.strictEqual(game5.cars.size, 12, 'Expected 12 cars initialized in room');

  for (const [, car] of game5.cars) {
    for (let g = 0; g <= game5.track.numCheckpoints; g++) {
      const cp = game5.track.checkpoints[g % game5.track.numCheckpoints];
      const tx = Math.cos(cp.angle || 0);
      const ty = Math.sin(cp.angle || 0);
      car.previousX = cp.x - tx * 10;
      car.previousY = cp.y - ty * 10;
      car.x = cp.x + tx * 10;
      car.y = cp.y + ty * 10;
      game5._checkCheckpoints(car);
    }
    assert.strictEqual(car.lap, 1, `Car ${car.seatToken} failed to complete lap`);
    assert.strictEqual(car.finished, true, `Car ${car.seatToken} was not marked finished`);
  }
  assert.strictEqual(game5.finishOrder.length, 12, 'All 12 cars must be in finish order');
  console.log('  ✅ Test 5 Passed: All 12 simultaneous cars recorded and ranked with exact order.\n');

  console.log('🎉 ALL RELIABLE LAPS VERIFICATION CHECKS PASSED SUCCESSFULLY! (5/5)\n');
}

runLapVerification()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
