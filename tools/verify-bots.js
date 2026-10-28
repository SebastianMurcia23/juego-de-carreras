/**
 * Simple checkpoint-following bot verification.
 * Uses GameRoom directly with a no-op Socket.IO adapter.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const flags = require('../config/feature-flags');
const tracks = require('../config/tracks');
const GameRoom = require('../server/GameRoom');

const MAX_TICKS = 30 * 90;
const DT = 1 / 30;

function fakeIo() {
  return {
    to() {
      return {
        emit() {},
      };
    },
  };
}

function makeRoom(track) {
  const seatToken = `bot-${track.id}`;
  return {
    settings: {
      mode: 'single',
      trackId: track.id,
      laps: 1,
      ammoMultiplier: 1,
      friendlyFire: false,
    },
    seats: new Map([[
      seatToken,
      {
        token: seatToken,
        name: 'Verification Bot',
        isHost: true,
        carId: 'viper_gt',
        weaponId: 'vulcan_mg',
      },
    ]]),
    championship: {
      raceNumber: 0,
      standings: new Map(),
    },
  };
}

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Pick a lookahead target CP. When the car is fast and close to the current
 * CP, look one or two CPs ahead so the bot stays on a smooth racing line.
 */
function pickTarget(car, cps) {
  const n = cps.length;
  let idx = car.currentCP;
  const cp0 = cps[idx];
  const distToCurrent = Math.hypot(car.x - cp0.x, car.y - cp0.y);

  // Lookahead distance: scale with speed (faster = look further ahead)
  const lookaheadDist = Math.max(80, car.speed * 0.55);

  if (distToCurrent < lookaheadDist) {
    // Check if the next CP is close enough to consider as target
    const next = cps[(idx + 1) % n];
    const distToNext = Math.hypot(car.x - next.x, car.y - next.y);
    if (distToNext < lookaheadDist * 1.8) {
      idx = (idx + 1) % n;
    }
  }
  return cps[idx];
}

/**
 * Compute the upcoming corner sharpness (angle change between adjacent CP segments).
 * Returns a value 0..PI.
 */
function cornerAngleAhead(car, cps, lookahead) {
  const n = cps.length;
  const cur = car.currentCP;
  let worst = 0;
  for (let k = 0; k < lookahead; k++) {
    const a = cps[(cur + k) % n];
    const b = cps[(cur + k + 1) % n];
    const c = cps[(cur + k + 2) % n];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (mag > 0) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot / mag)));
      worst = Math.max(worst, angle);
    }
  }
  return worst;
}

function runTrack(track) {
  const roomData = makeRoom(track);
  const game = new GameRoom(fakeIo(), `bot-${track.id}`, roomData);
  game.state = 'racing';
  const seatToken = `bot-${track.id}`;
  const car = game.cars.get(seatToken);
  let maxSpeed = 0;
  let maxDistanceFromTrack = 0;

  // Wall-recovery state
  let stallTicks = 0;      // ticks with very low speed
  let recoverTicks = 0;    // ticks remaining in reverse-recovery phase

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const cps = game.track.checkpoints;

    // ── Stall / wall-recovery detection ──────────────────────────────────
    if (car.speed < 20) {
      stallTicks++;
    } else {
      stallTicks = 0;
    }
    if (stallTicks > 45) {   // ~1.5 s stalled
      recoverTicks = 40;     // ~1.3 s of reverse
      stallTicks = 0;
    }

    let steer, accel, brake;

    if (recoverTicks > 0) {
      // Reverse and steer away from the wall
      recoverTicks--;
      const checkpoint = cps[car.currentCP];
      const targetAngle = Math.atan2(checkpoint.y - car.y, checkpoint.x - car.x);
      const angleError = normalizeAngle(targetAngle - car.angle);
      steer = Math.max(-1, Math.min(1, -angleError * 1.2));
      accel = false;
      brake = true;  // reverse thrust via brake while going slow
    } else {
      // ── Normal driving ────────────────────────────────────────────────
      const target = pickTarget(car, cps);
      const targetAngle = Math.atan2(target.y - car.y, target.x - car.x);
      const angleError = normalizeAngle(targetAngle - car.angle);

      // Stronger proportional gain so the bot turns crisply
      steer = Math.max(-1, Math.min(1, angleError * 2.0));

      // Anticipatory braking: slow down before tight corners
      const cornerAngle = cornerAngleAhead(car, cps, 3);
      // cornerAngle: 0 = straight, PI = hairpin
      // Brake if heading error OR upcoming corner demands it
      const headingBrake = Math.abs(angleError) > 0.55 && car.speed > 140;
      const cornerBrake = cornerAngle > 0.55 && car.speed > 180;
      brake = headingBrake || cornerBrake;
      accel = !brake;
    }

    game.setInput(seatToken, {
      steer,
      accel,
      brake,
      fire: false,
      drift: false,
      steerSeq: tick,
    });
    game.tick(DT);
    maxSpeed = Math.max(maxSpeed, car.speed);

    // Track distance (closest checkpoint, not segment — keeps metric compatible)
    const distance = Math.min(...cps.map(point =>
      Math.hypot(car.x - point.x, car.y - point.y)
    ));
    maxDistanceFromTrack = Math.max(maxDistanceFromTrack, distance);

    if (car.finished) {
      return {
        id: track.id,
        completed: true,
        ticks: tick + 1,
        seconds: Number(((tick + 1) * DT).toFixed(2)),
        maxSpeed: Number(maxSpeed.toFixed(2)),
        maxDistanceFromTrack: Number(maxDistanceFromTrack.toFixed(2)),
        error: null,
      };
    }
  }

  return {
    id: track.id,
    completed: false,
    ticks: MAX_TICKS,
    seconds: Number((MAX_TICKS * DT).toFixed(2)),
    maxSpeed: Number(maxSpeed.toFixed(2)),
    maxDistanceFromTrack: Number(maxDistanceFromTrack.toFixed(2)),
    error: `bot did not complete one lap within ${MAX_TICKS * DT} seconds`,
  };
}

function main() {
  if (!flags.USE_F1_TRACKS_AND_CARS) {
    throw new Error('USE_F1_TRACKS_AND_CARS must be true');
  }
  const results = tracks.map(runTrack);
  const summary = {
    tracks: results.length,
    completed: results.filter(result => result.completed).length,
    failed: results.filter(result => !result.completed).length,
    results,
  };
  fs.writeFileSync(
    path.join(__dirname, 'bot-verification.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );
  console.log(JSON.stringify({
    tracks: summary.tracks,
    completed: summary.completed,
    failed: summary.failed,
  }, null, 2));
  if (summary.failed) process.exitCode = 1;
}

main();
