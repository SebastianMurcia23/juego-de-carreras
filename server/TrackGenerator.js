/**
 * server/TrackGenerator.js
 * Generates procedural track geometry from track config definitions.
 * Produces checkpoint nodes, road segments, terrain zones, and start positions.
 */
'use strict';

const SHARED = require('../shared/constants');
const PHY    = SHARED.PHYSICS;

/**
 * Generate a closed-loop track with checkpoints.
 * Each track config has lengthMeters and checkpointsCount – we use those
 * to create a varied loop.
 *
 * @param {object} trackConfig  - Track definition from config/tracks.js
 * @param {number} playerCount  - Number of players (for start grid)
 * @returns {object} trackData
 */
function generateTrack(trackConfig, playerCount) {
  const id           = trackConfig.id;
  const numCPs       = trackConfig.checkpointsCount || 16;
  const lengthMeters = trackConfig.lengthMeters || 1500;

  // Scale: 1 meter ≈ 3 px for a good zoom level
  const scalePx      = lengthMeters * 3;
  const centerX      = 0;
  const centerY      = 0;

  // Create checkpoint nodes in a deformed-ellipse shape
  const checkpoints  = [];
  const baseRadiusX  = scalePx / (2 * Math.PI) * 1.3;
  const baseRadiusY  = baseRadiusX * 0.7;

  // Seed-based pseudo-random for deterministic track shape per trackId
  let seed = hashString(id);

  for (let i = 0; i < numCPs; i++) {
    const t      = (i / numCPs) * Math.PI * 2;
    const noiseR = seededRandom(seed + i * 137) * 0.25 - 0.125;
    const rx     = baseRadiusX * (1 + noiseR);
    const ry     = baseRadiusY * (1 + seededRandom(seed + i * 251) * 0.3 - 0.15);

    const x = centerX + Math.cos(t) * rx;
    const y = centerY + Math.sin(t) * ry;

    // Terrain type varies by track and checkpoint position
    const terrain = pickTerrain(trackConfig, i, numCPs, seed);

    checkpoints.push({
      index: i,
      x: Math.round(x),
      y: Math.round(y),
      terrain,
    });
  }

  // Smooth the checkpoints with Catmull-Rom to get a nicer curve
  const smoothed = smoothCheckpoints(checkpoints, 4); // 4 interpolated per segment

  // Compute road edges and tangent angles
  for (let i = 0; i < smoothed.length; i++) {
    const next = smoothed[(i + 1) % smoothed.length];
    const dx   = next.x - smoothed[i].x;
    const dy   = next.y - smoothed[i].y;
    smoothed[i].angle = Math.atan2(dy, dx);
  }

  // Compute bounds for the mini-map
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cp of smoothed) {
    if (cp.x < minX) minX = cp.x;
    if (cp.y < minY) minY = cp.y;
    if (cp.x > maxX) maxX = cp.x;
    if (cp.y > maxY) maxY = cp.y;
  }

  // Generate start positions (staggered grid behind the start/finish line)
  const startPositions = [];
  const startCP   = smoothed[0];
  const startAngle = startCP.angle;
  const perpAngle  = startAngle + Math.PI / 2;

  for (let i = 0; i < Math.max(playerCount, 12); i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const lateralOffset = (col === 0 ? -1 : 1) * 22;
    const backOffset    = -(row + 1) * 50;

    startPositions.push({
      x:     startCP.x + Math.cos(startAngle) * backOffset + Math.cos(perpAngle) * lateralOffset,
      y:     startCP.y + Math.sin(startAngle) * backOffset + Math.sin(perpAngle) * lateralOffset,
      angle: startAngle,
    });
  }

  // Generate Boost Pads (places on smooth straight-ish sections)
  const boostPads = [];
  const padStep = Math.max(8, Math.floor(smoothed.length / 5));
  for (let i = Math.floor(padStep / 2); i < smoothed.length - 2; i += padStep) {
    const cp = smoothed[i];
    boostPads.push({
      id:    `pad_${i}`,
      x:     cp.x,
      y:     cp.y,
      angle: cp.angle,
      w:     44,
      h:     28,
    });
  }

  // Generate Pickups (repair, ammo, shield, nitro)
  const pickups = [];
  const pickupTypes = ['repair', 'ammo', 'shield', 'nitro'];
  const pkStep = Math.max(6, Math.floor(smoothed.length / 8));
  let typeIdx = 0;

  for (let i = 3; i < smoothed.length - 1; i += pkStep) {
    const cp = smoothed[i];
    // Slightly offset from exact center for variety
    const perp = cp.angle + Math.PI / 2;
    const lateral = ((i % 2 === 0) ? 1 : -1) * (PHY.ROAD_HALF_WIDTH * 0.35);
    pickups.push({
      id:    `pk_${i}`,
      type:  pickupTypes[typeIdx % pickupTypes.length],
      x:     Math.round(cp.x + Math.cos(perp) * lateral),
      y:     Math.round(cp.y + Math.sin(perp) * lateral),
    });
    typeIdx++;
  }

  return {
    id,
    name:           trackConfig.name,
    color:          trackConfig.color,
    checkpoints:    smoothed,
    numCheckpoints: smoothed.length,
    startPositions,
    boostPads,
    pickups,
    roadHalfWidth:  PHY.ROAD_HALF_WIDTH,
    bounds: { minX: minX - 200, minY: minY - 200, maxX: maxX + 200, maxY: maxY + 200 },
  };
}

/* ─── Catmull-Rom interpolation ──────────────────────────────────────────── */
function smoothCheckpoints(points, subdivisions) {
  const result = [];
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    for (let s = 0; s < subdivisions; s++) {
      const t  = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;

      const x = 0.5 * ((2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

      const y = 0.5 * ((2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

      // Inherit terrain from the nearest base checkpoint
      const terrain = (s < subdivisions / 2) ? p1.terrain : p2.terrain;

      result.push({
        index: result.length,
        x: Math.round(x),
        y: Math.round(y),
        terrain,
      });
    }
  }

  return result;
}

/* ─── Terrain selection ──────────────────────────────────────────────────── */
function pickTerrain(trackConfig, cpIndex, total, seed) {
  const tid = trackConfig.id;

  // Map track types to terrain distributions
  const terrainMaps = {
    'track_01_neon_city':      ['asphalt'],
    'track_02_dusty_canyon':   ['dirt', 'dirt', 'dirt', 'rock', 'sand'],
    'track_03_cyber_docks':    ['asphalt', 'asphalt', 'asphalt'],
    'track_04_scorched_desert':['sand', 'sand', 'dirt', 'sand'],
    'track_05_industrial_ruins':['asphalt', 'asphalt', 'rock'],
    'track_06_skyline_highway':['asphalt'],
    'track_07_toxic_jungle':   ['mud', 'mud', 'grass', 'mud', 'dirt'],
    'track_08_subterranean_mine':['rock', 'rock', 'dirt'],
    'track_09_obsidian_volcano':['rock', 'rock', 'sand', 'rock'],
    'track_10_omega_grand_prix':['asphalt', 'dirt', 'grass', 'sand', 'rock', 'mud'],
  };

  const terrains = terrainMaps[tid] || ['asphalt'];
  const idx = Math.floor(seededRandom(seed + cpIndex * 73) * terrains.length);
  return terrains[idx];
}

/* ─── Deterministic hash / random ────────────────────────────────────────── */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededRandom(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

module.exports = { generateTrack };
