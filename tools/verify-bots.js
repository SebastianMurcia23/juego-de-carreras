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

function runTrack(track) {
  const roomData = makeRoom(track);
  const game = new GameRoom(fakeIo(), `bot-${track.id}`, roomData);
  game.state = 'racing';
  const seatToken = `bot-${track.id}`;
  const car = game.cars.get(seatToken);
  let maxSpeed = 0;
  let maxDistanceFromTrack = 0;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const checkpoint = game.track.checkpoints[car.currentCP];
    const targetAngle = Math.atan2(checkpoint.y - car.y, checkpoint.x - car.x);
    const angleError = normalizeAngle(targetAngle - car.angle);
    const steer = Math.max(-1, Math.min(1, angleError * 1.6));
    const brake = Math.abs(angleError) > 0.65 && car.speed > 150;
    game.setInput(seatToken, {
      steer,
      accel: !brake,
      brake,
      fire: false,
      drift: false,
      steerSeq: tick,
    });
    game.tick(DT);
    maxSpeed = Math.max(maxSpeed, car.speed);
    const distance = Math.min(...game.track.checkpoints.map(point =>
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
