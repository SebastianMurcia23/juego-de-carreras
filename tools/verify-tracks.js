/**
 * Runtime verification for active tracks.
 * Uses the real TrackGenerator without modifying GameRoom.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const flags = require('../config/feature-flags');
const tracks = require('../config/tracks');
const geo = require('../config/tracks-geo.json');
const { generateTrack } = require('../server/TrackGenerator');

const ROAD_HALF_WIDTH = 92;           // must match PHY.ROAD_HALF_WIDTH in shared/constants.js
const SCENERY_ROAD_HALF_WIDTH = 92;
const SCENERY_MARGIN = 60;
const SCENERY_DIR = path.join(__dirname, '..', 'config', 'scenery');
const START_LATERAL_LIMIT = ROAD_HALF_WIDTH * 2.15;

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function nearestDistance(point, checkpoints) {
  let minimum = Infinity;
  for (let i = 0; i < checkpoints.length; i++) {
    const a = checkpoints[i];
    const b = checkpoints[(i + 1) % checkpoints.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSq = abx * abx + aby * aby;
    const t = lengthSq
      ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq))
      : 0;
    const x = a.x + abx * t;
    const y = a.y + aby * t;
    minimum = Math.min(minimum, Math.hypot(point.x - x, point.y - y));
  }
  return minimum;
}

function boundsContain(bounds, checkpoints) {
  return checkpoints.every(point =>
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function verifyScenery(trackId, checkpoints) {
  if (!flags.USE_REAL_SCENERY) return { enabled: false, features: 0, errors: [] };
  const file = path.join(SCENERY_DIR, `${trackId}.json`);
  if (!fs.existsSync(file)) return { enabled: true, features: 0, errors: ['missing scenery file'] };
  const scenery = JSON.parse(fs.readFileSync(file, 'utf8'));
  const limit = SCENERY_ROAD_HALF_WIDTH + SCENERY_MARGIN;
  const errors = [];
  for (const feature of scenery.features || []) {
    for (const point of feature.geometry || []) {
      if (nearestDistance(point, checkpoints) < limit) {
        errors.push(`${feature.type}/${feature.id} intersects road exclusion`);
        break;
      }
    }
  }
  return { enabled: true, features: (scenery.features || []).length, errors };
}

function verifyTrack(config) {
  const generated = generateTrack(config, 12);
  const errors = [];
  const warnings = [];
  const checkpoints = generated.checkpoints;
  const first = checkpoints[0];
  const last = checkpoints[checkpoints.length - 1];
  const closureGap = distance(first, last);
  const startDistances = generated.startPositions.map(start =>
    nearestDistance(start, checkpoints)
  );
  const startsBehind = generated.startPositions.every(start => {
    const forwardX = Math.cos(first.angle);
    const forwardY = Math.sin(first.angle);
    const deltaX = start.x - first.x;
    const deltaY = start.y - first.y;
    return deltaX * forwardX + deltaY * forwardY < 0;
  });

  if (checkpoints.length !== config.checkpointsCount) errors.push('checkpoint count mismatch');
  if (closureGap > ROAD_HALF_WIDTH * 2.15) errors.push(`large closure gap ${closureGap.toFixed(1)}`);
  if (!boundsContain(generated.bounds, checkpoints)) errors.push('bounds do not contain checkpoints');
  if (generated.startPositions.length !== 12) errors.push('missing 12 start positions');
  if (!startsBehind) errors.push('one or more starts are not behind the line');
  if (startDistances.some(value => value > START_LATERAL_LIMIT)) {
    errors.push('one or more starts are outside the road tolerance');
  }
  const scenery = verifyScenery(config.id, checkpoints);
  errors.push(...scenery.errors);
  if (config.validationWarning) warnings.push(config.validationWarning);

  return {
    id: config.id,
    checkpoints: checkpoints.length,
    closureGap: Number(closureGap.toFixed(2)),
    maxStartDistance: Number(Math.max(...startDistances).toFixed(2)),
    startsBehind,
    boundsValid: boundsContain(generated.bounds, checkpoints),
    scenery,
    errors,
    warnings,
  };
}

function main() {
  if (!flags.USE_F1_TRACKS_AND_CARS) {
    throw new Error('USE_F1_TRACKS_AND_CARS must be true for this verification');
  }
  const results = tracks.map(verifyTrack);
  const failed = results.filter(result => result.errors.length);
  const maxCheckpoints = Math.max(...results.map(result => result.checkpoints));
  const currentTickSegmentChecks = maxCheckpoints * 12;
  const legacyMaxCheckpoints = Math.max(...require('../config/tracks.legacy').map(track =>
    (track.checkpointsCount || 16) * 4
  ));
  const summary = {
    source: path.relative(process.cwd(), __filename),
    tracks: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    warningCount: results.filter(result => result.warnings.length).length,
    maxCheckpoints,
    currentTickSegmentChecks,
    legacyMaxCheckpoints,
    results,
  };
  fs.writeFileSync(
    path.join(__dirname, 'track-verification.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );
  console.log(JSON.stringify({
    tracks: summary.tracks,
    passed: summary.passed,
    failed: summary.failed,
    warningCount: summary.warningCount,
    maxCheckpoints,
    currentTickSegmentChecks,
    legacyMaxCheckpoints,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main();
