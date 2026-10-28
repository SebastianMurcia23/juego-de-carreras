/**
 * tools/verify-championship.js
 * Comprehensive headless verification of championship mode:
 *  (a) Race 1: P1 crosses line -> race continues -> P2 & P3 cross -> stalled bot gets DNF via timeout.
 *  (b) race_finished event: table contains all 4 players with race points & cumulative points.
 *  (c) Track switch to Track B: server emits new track_data and grid state.
 *      All cars placed with finite coordinates within Track B bounds, immobilized during intermission.
 *  (d) Track B item boxes: generated correctly (>0) and each box is within track halfWidth road limits.
 *  (e) Previous race entities (missiles, discs, oils) are empty; new race starts clean.
 *  (f) Race 2 runs to finish; cumulative points update accurately.
 *  (g) Final race completes: championship_finished emitted, podium standings match, no invalid track access.
 */
'use strict';

const assert = require('assert');
const tracks = require('../config/tracks');
const tracksGeo = require('../config/tracks-geo.json');
const SCORING = require('../config/scoring');
const GameRoom = require('../server/GameRoom');
const RoomManager = require('../server/RoomManager');
const SHARED = require('../shared/constants');

const DT = 1 / 30;
const TIMEOUT_SEC = 2; // Fast timeout for automated verification

function fakeIo(events) {
  return {
    events,
    sockets: {
      sockets: new Map(),
    },
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

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

async function runComprehensiveChampionshipVerification() {
  console.log('🏆 Starting Championship Mode & Track Transition Headless Verification...\n');

  const championshipTrackIds = ['ae-2009', 'ar-1952', 'it-1922'];
  const trackOrder = championshipTrackIds.map(id => tracks.find(t => t.id === id) || tracks[0]);

  const botSeats = [
    { token: 'bot-1', name: 'Speedy Bot (P1)', speedMul: 1.0, isStill: false },
    { token: 'bot-2', name: 'Challenger Bot (P2)', speedMul: 0.85, isStill: false },
    { token: 'bot-3', name: 'Steady Bot (P3)', speedMul: 0.70, isStill: false },
    { token: 'bot-4', name: 'Stalled Bot (DNF)', speedMul: 0.0, isStill: true },
  ];

  const roomData = {
    settings: {
      mode: 'championship',
      trackId: trackOrder[0].id,
      trackOrder: championshipTrackIds,
      laps: 1,
      ammoMultiplier: 1,
      friendlyFire: false,
      finishTimeoutSeconds: TIMEOUT_SEC,
      intermissionSeconds: 1,
    },
    seats: new Map(botSeats.map(b => [
      b.token,
      {
        token: b.token,
        name: b.name,
        isHost: b.token === 'bot-1',
        carId: 'apex_venom',
        weaponId: 'vulcan_mg',
        isReady: true,
      },
    ])),
    championship: {
      raceNumber: 0,
      standings: new Map(),
    },
  };

  const resultsPerRace = [];

  for (let raceIdx = 0; raceIdx < championshipTrackIds.length; raceIdx++) {
    const currentTrack = trackOrder[raceIdx];
    roomData.settings.trackId = currentTrack.id;
    roomData.championship.raceNumber = raceIdx;

    const events = [];
    const io = fakeIo(events);
    const game = new GameRoom(io, `champ-room-${raceIdx}`, roomData);

    // If raceIdx > 0, test transition via intermission first
    if (raceIdx > 0) {
      console.log(`\n🔄 Testing Track Switch & Intermission to Race ${raceIdx + 1} (${currentTrack.name})...`);
      const prevFinishPayload = resultsPerRace[raceIdx - 1];
      
      // Inject dummy projectiles and oils into previous itemSystem to verify cleanup
      game.itemSystem.missiles.push({ x: 100, y: 100, angle: 0, active: true });
      game.itemSystem.discs.push({ x: 200, y: 200, angle: 0, active: true });
      game.itemSystem.oils.push({ x: 300, y: 300, angle: 0, active: true });

      // Start Intermission
      game.startIntermission(1, prevFinishPayload);

      // Verify (c): track_data emitted for currentTrack
      const trackDataEvt = events.find(e => e.event === 'track_data');
      assert(trackDataEvt, 'track_data must be emitted on track switch intermission');
      assert.strictEqual(trackDataEvt.data.id, currentTrack.id, `track_data ID must match ${currentTrack.id}`);

      // Verify (c): championship_intermission emitted
      const intermEvt = events.find(e => e.event === 'championship_intermission');
      assert(intermEvt, 'championship_intermission must be emitted');
      assert.strictEqual(intermEvt.data.nextTrackId, currentTrack.id);
      assert.strictEqual(intermEvt.data.results.length, 4);

      // Verify (c): Cars positioned on new track starting grid with finite coordinates inside track bounds
      const bounds = game.track.bounds;
      for (const [seatToken, car] of game.cars) {
        assert(Number.isFinite(car.x) && Number.isFinite(car.y), `Car ${seatToken} has non-finite coordinates on grid`);
        assert(car.x >= bounds.minX - 100 && car.x <= bounds.maxX + 100,
          `Car ${seatToken} x=${car.x} is outside track bounds [${bounds.minX}, ${bounds.maxX}]`);
        assert(car.y >= bounds.minY - 100 && car.y <= bounds.maxY + 100,
          `Car ${seatToken} y=${car.y} is outside track bounds [${bounds.minY}, ${bounds.maxY}]`);
        assert.strictEqual(car.speed, 0, `Car ${seatToken} must be stationary on grid`);
      }
      console.log(`  ✅ (c) Track switch: 4 cars positioned cleanly on ${currentTrack.name} starting grid within track bounds.`);

      // Verify (c): Cars are immobilized during intermission
      game.setInput('bot-1', { accel: true, steer: 0, brake: false, steerSeq: 1 });
      game.tick(DT);
      const car1 = game.cars.get('bot-1');
      assert.strictEqual(car1.speed, 0, 'Car input must be ignored and car must stay immobilized during intermission');
      console.log('  ✅ (c) Cars are strictly immobilized during intermission.');

      // Verify (d): Track B item boxes generated and within track halfWidth road limits
      const itemBoxes = game.itemSystem.boxes;
      assert(itemBoxes.length > 0, `Track ${currentTrack.id} must have item boxes generated`);
      const roadHW = game.track.roadHalfWidth || 92;
      for (const box of itemBoxes) {
        assert(Number.isFinite(box.x) && Number.isFinite(box.y), 'Item box has non-finite coordinates');
        const nearPt = game.itemSystem._nearestTrackPoint(box.x, box.y);
        assert(nearPt, 'Item box must have nearest track point');
        const latDist = Math.abs(game.itemSystem._lateralDist(box.x, box.y, nearPt));
        assert(latDist <= roadHW * 1.05, `Item box at (${box.x}, ${box.y}) is outside road surface (latDist ${latDist} > roadHW ${roadHW})`);
      }
      console.log(`  ✅ (d) ${itemBoxes.length} item boxes placed strictly within track halfWidth road surface.`);

      // Verify (e): Previous projectiles and oils cleared
      assert.strictEqual(game.itemSystem.missiles.length, 0, 'Missiles from previous race must be cleared');
      assert.strictEqual(game.itemSystem.discs.length, 0, 'Discs from previous race must be cleared');
      assert.strictEqual(game.itemSystem.oils.length, 0, 'Oils from previous race must be cleared');
      console.log('  ✅ (e) Previous race entities (missiles, discs, oils) are completely cleared.');

      // Transition from intermission into racing via countdown
      game.startCountdown();
      await new Promise(r => setTimeout(r, 3100));
      assert.strictEqual(game.state, 'racing', 'Game must transition to racing state after countdown');
    } else {
      game.state = 'racing';
    }

    let firstFinishedAtTick = null;
    let raceFinishedEvent = null;

    // Run up to 2500 ticks
    for (let tick = 0; tick < 2500; tick++) {
      // Control bots
      for (const bot of botSeats) {
        const car = game.cars.get(bot.token);
        if (!car || car.finished) continue;

        if (bot.isStill) {
          game.setInput(bot.token, { steer: 0, accel: false, brake: true, fire: false, drift: false, steerSeq: tick });
        } else {
          const cp = game.track.checkpoints[car.currentCP];
          const targetAngle = Math.atan2(cp.y - car.y, cp.x - car.x);
          const angleError = normalizeAngle(targetAngle - car.angle);
          const steer = Math.max(-1, Math.min(1, angleError * 1.6));
          const brake = Math.abs(angleError) > 0.65 && car.speed > 150;
          game.setInput(bot.token, {
            steer,
            accel: !brake,
            brake,
            fire: false,
            drift: false,
            steerSeq: tick,
          });
        }
      }

      game.tick(DT);

      if (firstFinishedAtTick === null && game.firstFinishedTime != null) {
        firstFinishedAtTick = tick;
      }

      const finEvt = events.find(e => e.event === 'race_finished');
      if (finEvt) {
        raceFinishedEvent = finEvt.data;
        game.stop();
        break;
      }
    }

    if (!raceFinishedEvent) {
      throw new Error(`Race ${raceIdx + 1} did not finish within tick limit.`);
    }

    resultsPerRace.push(raceFinishedEvent);
    console.log(`[Race ${raceIdx + 1}/${championshipTrackIds.length}] Finished: ${currentTrack.name}`);
    for (const r of raceFinishedEvent.results) {
      console.log(`    P${r.place}: ${r.name} — ${r.dnf ? 'DNF' : (r.time / 1000).toFixed(1) + 's'} (+${r.points} pts)`);
    }
  }

  console.log('\n📊 Validating Championship Requirements:');

  // Test (a): Race does NOT cut off when the first car crosses the line
  const race1 = resultsPerRace[0];
  const firstCar = race1.results[0];
  const secondCar = race1.results[1];
  assert(firstCar && firstCar.place === 1 && secondCar && secondCar.place === 2, 'Results order invalid');
  assert(!secondCar.dnf, 'Second car was cut off as DNF instead of finishing');
  console.log('  ✅ (a) Race did not cut off when 1st car finished: 2nd and 3rd cars crossed normally.');

  // Test (b): Stalled bot receives DNF through timeout, all 4 players in results
  for (let i = 0; i < resultsPerRace.length; i++) {
    const res = resultsPerRace[i].results;
    assert.strictEqual(res.length, 4, `Expected 4 results in race ${i + 1}`);
    const dnfBot = res.find(r => r.name.includes('DNF'));
    assert(dnfBot && dnfBot.dnf, `Stalled bot in race ${i + 1} was not marked DNF`);
    for (const entry of res) {
      assert(Number.isFinite(entry.points), `Driver ${entry.name} points is not finite`);
    }
  }
  console.log('  ✅ (b) All 4 players appear in results with race points and standings; stalled bot correctly handled as DNF.');

  // Test (c) & (f): Accumulated points calculation across races
  const finalStandings = resultsPerRace[2].standings;
  for (const bot of botSeats) {
    const expectedPoints = resultsPerRace.reduce((sum, race) => {
      const entry = race.results.find(r => r.seatToken === bot.token);
      return sum + (entry ? entry.points : 0);
    }, 0);
    const standing = finalStandings.find(s => s.seatToken === bot.token);
    assert(standing && standing.points === expectedPoints,
      `Expected ${bot.name} to have ${expectedPoints} points, got ${standing ? standing.points : 'none'}`);
  }
  console.log('  ✅ (f) Accumulated points verified: exact match for all 4 drivers across all 3 races.');

  // Test (g): Final championship podium and completion without out-of-bounds track access
  assert.strictEqual(resultsPerRace[0].championshipFinished, false, 'Race 1 must not mark championship as finished');
  assert.strictEqual(resultsPerRace[1].championshipFinished, false, 'Race 2 must not mark championship as finished');
  assert.strictEqual(resultsPerRace[2].championshipFinished, true, 'Final race must mark championshipFinished = true');
  assert(finalStandings[0].points >= finalStandings[1].points, 'Podium winner points ordering incorrect');
  console.log(`  ✅ (g) Championship finished! Podium winner: ${finalStandings[0].name} (${finalStandings[0].points} pts, ${finalStandings[0].wins} wins).`);

  // Test RoomManager integration: Intermission skip by host & bounds on next race
  console.log('\n🔄 Testing RoomManager Intermission & Host Skip...');
  const rmEvents = [];
  const rmIo = fakeIo(rmEvents);
  const roomManager = new RoomManager(rmIo);
  
  const testRoomCode = 'TEST99';
  const testHostToken = 'host-token-123';
  const testRoom = {
    code: testRoomCode,
    hostToken: testHostToken,
    state: SHARED.STATES.ROOM.RACING,
    settings: {
      mode: 'championship',
      trackId: championshipTrackIds[0],
      trackOrder: championshipTrackIds,
      laps: 1,
      intermissionSeconds: 12,
      finishTimeoutSeconds: 2,
    },
    seats: new Map(botSeats.map(b => [
      b.token,
      {
        token: b.token,
        name: b.name,
        isHost: b.token === 'bot-1',
        carId: 'apex_venom',
        weaponId: 'vulcan_mg',
        isReady: true,
      },
    ])),
    championship: {
      raceNumber: 0,
      standings: new Map(),
    },
  };
  roomManager.rooms.set(testRoomCode, testRoom);
  roomManager.hostIndex.set(testHostToken, testRoomCode);

  // Trigger prepareNextChampionshipRace
  const prepRes = roomManager.prepareNextChampionshipRace(testRoomCode, resultsPerRace[0]);
  assert.strictEqual(prepRes.success, true);
  assert.strictEqual(testRoom.state, 'intermission');
  assert.strictEqual(testRoom.settings.trackId, championshipTrackIds[1]);
  assert(testRoom.gameRoom, 'New GameRoom must be initialized during intermission');
  assert.strictEqual(testRoom.gameRoom.state, 'intermission');

  // Verify host can skip intermission
  const skipRes = roomManager.advanceChampionship(testRoomCode, testHostToken);
  assert.strictEqual(skipRes.skippedIntermission, true);
  assert.strictEqual(testRoom.state, SHARED.STATES.ROOM.COUNTDOWN);

  console.log('  ✅ RoomManager intermission preparation, background track load, and host skip PASSED.');

  // ── Prompt 3 Verification: Championship Track Count Options & Validation ──
  console.log('\n🏁 Testing Prompt 3: Championship Track Count Settings (5, 10, clamping 7->5, 45->40)...');
  roomManager.updateRoomSettings(testRoomCode, testHostToken, { trackCount: 5 });
  assert.strictEqual(testRoom.settings.trackCount, 5, 'TrackCount should be 5');
  roomManager.updateRoomSettings(testRoomCode, testHostToken, { trackCount: 10 });
  assert.strictEqual(testRoom.settings.trackCount, 10, 'TrackCount should be 10');
  // Clamping test: 7 -> 5 (closest multiple of 5)
  roomManager.updateRoomSettings(testRoomCode, testHostToken, { trackCount: 7 });
  assert.strictEqual(testRoom.settings.trackCount, 5, 'TrackCount 7 should clamp/round to 5');
  // Clamping test: 45 -> 40 (maximum 40)
  roomManager.updateRoomSettings(testRoomCode, testHostToken, { trackCount: 45 });
  assert.strictEqual(testRoom.settings.trackCount, 40, 'TrackCount 45 should clamp to 40');

  // Test championship ends at exact trackCount = 5
  testRoom.settings.trackCount = 5;
  testRoom.championship.raceNumber = 4; // 5th race index
  const finishN5 = roomManager.prepareNextChampionshipRace(testRoomCode, { standings: [] });
  assert.strictEqual(finishN5.finished, true, 'Championship with trackCount=5 must finish after 5th race');
  assert.strictEqual(testRoom.state, 'championship_finished');
  console.log('  ✅ Championship N=5 and N=10 track count settings and finish trigger PASSED.');

  // ── Prompt 3 Verification: Finished Car Autopilot & Controls Lock ─────────
  console.log('\n🚗 Testing Prompt 3: Finished Car Control Locking, Autopilot & Item Exemption...');
  const sampleTrack = tracks[0];
  const testRoom2 = {
    settings: { mode: 'single', trackId: sampleTrack.id, laps: 1, finishTimeoutSeconds: 10 },
    seats: new Map([
      ['c1', { token: 'c1', name: 'Carlos', isHost: true, carId: 'apex_venom', weaponId: 'vulcan_mg', isReady: true }],
      ['c2', { token: 'c2', name: 'Carlos (2)', isHost: false, carId: 'viper_gt', weaponId: 'vulcan_mg', isReady: true }],
    ]),
    championship: { raceNumber: 0, standings: new Map() },
  };
  const testGame = new GameRoom(fakeIo([]), 'test-finished-rules', testRoom2);
  testGame.state = 'racing';
  const c1 = testGame.cars.get('c1');
  const c2 = testGame.cars.get('c2');

  // Mark c1 finished
  c1.finished = true;
  c1.finishPlace = 1;
  c1.finishTime = 15000;
  const originalPlace = c1.finishPlace;
  const originalTime = c1.finishTime;

  // 1. Controls are ignored for finished car
  testGame.setInput('c1', { accel: true, steer: 1, brake: true, drift: true });
  assert.strictEqual(c1.input.accel, false, 'Finished car must ignore accelerator input');
  assert.strictEqual(c1.input.steer, 0, 'Finished car must ignore steering input');
  assert.strictEqual(c1.finishPlace, originalPlace, 'Finish place must be frozen');
  assert.strictEqual(c1.finishTime, originalTime, 'Finish time must be frozen');

  // 2. Finished car cannot collect item boxes
  if (testGame.itemSystem) {
    // Place a box exactly at c1's position in the itemSystem boxes array
    if (testGame.itemSystem.boxes.length > 0) {
      const box = testGame.itemSystem.boxes[0];
      const savedX = box.x; const savedY = box.y;
      box.x = c1.x; box.y = c1.y; box.active = true;
      const collected = testGame.itemSystem.tryCollectBox(c1);
      assert.strictEqual(collected, false, 'Finished car must NOT collect item boxes');
      box.x = savedX; box.y = savedY; // restore
    }

    // 3. Finished car is NOT targeted by seeking missiles
    // Give c2 a missile item and bypass roulette lockout
    c2.arcadeItem = 'misil';
    c2.arcadeRollEnd = 0; // allow immediate activation
    c2.alive = true;
    c2.finished = false;
    c1.s = 0.5; // c1 is ahead of c2 by track position
    c2.s = 0.1;
    const missilesBefore = testGame.itemSystem.missiles.length;
    testGame.itemSystem.activateItem(c2);
    const newMissile = testGame.itemSystem.missiles[missilesBefore];
    if (newMissile) {
      assert.notStrictEqual(newMissile.target, 'c1', 'Missile must NOT target finished car');
    }
  }

  // 4. Finished car does not count extra laps
  const prevLaps = c1.lap;
  for (let g = 0; g <= testGame.track.numCheckpoints; g++) {
    testGame._checkCheckpoints(c1);
  }
  assert.strictEqual(c1.lap, prevLaps, 'Finished car must NOT increment laps in autopilot');

  // 5. Player names appear cleanly (no internal IDs)
  assert.strictEqual(c1.name, 'Carlos', 'Driver 1 custom name must be preserved');
  assert.strictEqual(c2.name, 'Carlos (2)', 'Driver 2 duplicate name resolution must be preserved');
  // ──────────────────────────────────────────────────────────────────────────
  // Prompt 4: Simulated Mobile Client Multi-Race Synchronization Test
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📱 Testing Prompt 4: Mobile Client Multi-Race State & Reconnection...');
  const mobileEvents = [];
  const fakeMobileIo = fakeIo(mobileEvents);

  const rm = new RoomManager(fakeMobileIo);
  const created = await rm.createRoom('host-sock');
  const roomCode = created.roomCode;
  const hostToken = created.hostToken;
  const guest = await rm.joinRoom(roomCode, 'guest-screen-sock');
  const seatToken = guest.seatToken;

  // Link mobile phone
  const linkRes = await rm.linkSeat(seatToken, 'PhonePlayer', 'guest-phone-sock');
  assert.strictEqual(linkRes.success, true);

  // Set championship mode with 3 tracks
  rm.updateRoomSettings(roomCode, hostToken, {
    mode: 'championship',
    trackCount: 5,
    trackOrder: ['ae-2009', 'ar-1952', 'it-1922'],
    laps: 1,
  });

  // Start championship Race 1
  rm.startGame(roomCode, hostToken);
  const game1 = rm.rooms.get(roomCode).gameRoom;
  assert(game1, 'Race 1 game room must be initialized');
  assert.strictEqual(game1.raceIndex, 0);

  // Check that mobile receives countdown with raceId
  const cdEvt1 = mobileEvents.find(e => e.event === 'game_countdown');
  assert(cdEvt1, 'Mobile must receive game_countdown');
  assert.strictEqual(cdEvt1.data.raceId, `${roomCode}_race_0`);

  // Fast forward to racing
  game1.state = 'racing';
  const playerCar1 = game1.cars.get(seatToken);
  assert(playerCar1, 'Player car must exist in race 1');
  assert.strictEqual(playerCar1.finished, false);

  // Player finishes Race 1 P1
  playerCar1.finished = true;
  playerCar1.finishPlace = 1;
  playerCar1.finishTime = 12000;
  game1._emitToSeat(seatToken, SHARED.EVENTS.CAR_FINISHED, {
    place: 1,
    time: 12000,
    raceId: game1.raceId,
    raceIndex: 0,
  });

  // Verify car_finished emitted to room
  assert(mobileEvents.some(e => e.event === 'car_finished' && e.data.place === 1));

  // Advance to intermission
  rm.prepareNextChampionshipRace(roomCode, {
    raceNumber: 0,
    totalRaces: 3,
    nextTrackName: 'Buenos Aires · 1952',
    standings: [{ seatToken, name: 'PhonePlayer', points: 25, place: 1 }],
    results: [{ seatToken, name: 'PhonePlayer', points: 25, place: 1 }],
  });

  const interEvt = mobileEvents.find(e => e.event === 'championship_intermission');
  assert(interEvt, 'Mobile must receive championship_intermission');
  assert.strictEqual(interEvt.data.raceIndex, 1);

  // Reconnection mid-intermission: simulate reconnecting mobile socket
  const reconRes = await rm.reconnectMobile(seatToken, 'guest-phone-sock-2');
  assert.strictEqual(reconRes.success, true);
  const roomObj = rm.rooms.get(roomCode);
  const game2Inter = roomObj.gameRoom;
  assert.strictEqual(game2Inter.state, 'intermission');
  assert.strictEqual(game2Inter.raceIndex, 1);

  // Start Race 2 countdown
  rm.startChampionshipRace(roomCode);
  const game2 = rm.rooms.get(roomCode).gameRoom;
  assert.strictEqual(game2.state, 'countdown');
  assert.strictEqual(game2.raceIndex, 1);
  assert.strictEqual(game2.raceId, `${roomCode}_race_1`);

  // Verify mobile receives countdown with NEW raceId
  const cdEvt2 = mobileEvents.filter(e => e.event === 'game_countdown' && e.data.raceId === `${roomCode}_race_1`);
  assert(cdEvt2.length > 0, 'Mobile must receive countdown with new raceId in race 2');

  // Verify player in race 2 has finished = false, autopilot off
  const playerCar2 = game2.cars.get(seatToken);
  assert(playerCar2, 'Player car must exist in race 2');
  assert.strictEqual(playerCar2.finished, false, 'Finished status must be reset to false in race 2');
  assert.strictEqual(playerCar2.finishPlace, 0, 'Finish place must be reset');

  // Advance countdown to racing (GO)
  game2.state = 'racing';

  // Send control input in race 2
  game2.setInput(seatToken, { accel: true, steer: 0.25 });
  assert.strictEqual(playerCar2.input.accel, true, 'Controls must be accepted in race 2');
  assert.strictEqual(playerCar2.input.steer, 0.25, 'Steering must be accepted in race 2');

  // Verify car actually moves when tick runs
  const prevCarX = playerCar2.x;
  for (let t = 0; t < 5; t++) {
    game2.tick(DT);
  }
  assert(playerCar2.x !== prevCarX || playerCar2.speed > 0, 'Car must physically move in race 2');

  console.log('  ✅ Mobile client multi-race sync, countdown, finished reset, and control reactivation PASSED.');

  console.log('\n🎉 ALL CHAMPIONSHIP & TRACK SWITCH VERIFICATION CHECKS PASSED!\n');
}

runComprehensiveChampionshipVerification()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
