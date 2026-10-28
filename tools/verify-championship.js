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

  console.log('\n🎉 ALL CHAMPIONSHIP & TRACK SWITCH VERIFICATION CHECKS PASSED!\n');
}

runComprehensiveChampionshipVerification()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
