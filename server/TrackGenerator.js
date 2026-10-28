/**
 * server/TrackGenerator.js
 * Generates procedural track geometry from track config definitions.
 * Produces checkpoint nodes, road segments, terrain zones, and start positions.
 */
'use strict';

const SHARED = require('../shared/constants');
const PHY    = SHARED.PHYSICS;
const FLAGS  = require('../config/feature-flags');
const GEO_TRACKS = require('../config/tracks-geo.json');

function trackTheme(trackConfig, geoTrack) {
  const id = String((geoTrack && geoTrack.id) || (trackConfig && trackConfig.id) || '').toLowerCase();
  const terrain = String((trackConfig && trackConfig.terrain) || '').toLowerCase();
  if (/ae|qa|bh|sa|az|mx/.test(id) || /arena|tierra|desierto|seco|calido/.test(terrain)) return 'desert';
  if (/mc|sg|az|au|ca|it|es/.test(id) || /urbano|ciudad|metal|puerto/.test(terrain)) return 'urban';
  if (/be|gb|nl|de|at|hu|jp|ch/.test(id) || /bosque|verde|humedo|lluvia/.test(terrain)) return 'forest';
  if (/br|za|my|tr|pt/.test(id) || /costa|tropical|playa|mar/.test(terrain)) return 'coastal';
  return 'classic';
}

function scalePoint(point) {
  return {
    x: point.x * PHY.TRACK_LENGTH_SCALE,
    y: point.y * PHY.TRACK_LENGTH_SCALE,
  };
}

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
  if (FLAGS.USE_F1_TRACKS_AND_CARS && trackConfig && trackConfig.enabled) {
    const geoTrack = GEO_TRACKS.tracks.find(track => track.id === trackConfig.id);
    if (geoTrack) return generateGeoTrack(trackConfig, geoTrack, playerCount);
  }

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
      x: Math.round(x * PHY.TRACK_LENGTH_SCALE),
      y: Math.round(y * PHY.TRACK_LENGTH_SCALE),
      terrain,
    });
  }

  /**
   * Adapt prebuilt local-metre geometry to the existing track_data contract.
   * The remaining gameplay objects intentionally use the same generation rules
   * as legacy tracks so physics and pickup behavior remain unchanged.
   */
  function generateGeoTrack(trackConfig, geoTrack, playerCount) {
    const checkpoints = geoTrack.geometry.map((point, index) => {
      const scaled = scalePoint(point);
      const next = scalePoint(geoTrack.geometry[(index + 1) % geoTrack.geometry.length]);
      return {
        index,
        x: scaled.x,
        y: scaled.y,
        angle: Math.atan2(next.y - scaled.y, next.x - scaled.x),
        terrain: pickTerrain(trackConfig, index, geoTrack.geometry.length, hashString(geoTrack.id)),
      };
    });

    const bounds = checkpoints.reduce((result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y),
    }), {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    });

    const startPositions = [];
    const startCP = checkpoints[0];
    const startAngle = startCP.angle;
    const centerlineLength = checkpoints.reduce((total, point, index) =>
      total + Math.hypot(
        checkpoints[(index + 1) % checkpoints.length].x - point.x,
        checkpoints[(index + 1) % checkpoints.length].y - point.y
      ), 0);

    function pointBehindStart(distanceBack) {
      let remaining = distanceBack % centerlineLength;
      let currentIndex = 0;
      while (currentIndex < checkpoints.length) {
        const current = checkpoints[currentIndex];
        const previousIndex = (currentIndex - 1 + checkpoints.length) % checkpoints.length;
        const previous = checkpoints[previousIndex];
        const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);
        if (remaining <= segmentLength) {
          const ratio = segmentLength ? remaining / segmentLength : 0;
          const x = current.x + (previous.x - current.x) * ratio;
          const y = current.y + (previous.y - current.y) * ratio;
          const angle = Math.atan2(current.y - previous.y, current.x - previous.x);
          return { x, y, angle };
        }
        remaining -= segmentLength;
        currentIndex = previousIndex;
      }
      return { x: startCP.x, y: startCP.y, angle: startAngle };
    }

    for (let i = 0; i < Math.max(playerCount, 12); i++) {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const lateralOffset = (col - 1.5) * 40;  // cols: -60, -20, +20, +60 (within ±92 half-width)
      const rowPoint = pointBehindStart((row + 1) * 55);  // extra spacing keeps cars behind
      // Use the global start angle (CP[0]) for the lateral offset so ALL starts are
      // guaranteed to lie behind the finish line regardless of curve at that point.
      const perpAngle = startAngle + Math.PI / 2;
      startPositions.push({
        x: rowPoint.x + Math.cos(perpAngle) * lateralOffset,
        y: rowPoint.y + Math.sin(perpAngle) * lateralOffset,
        angle: rowPoint.angle,
      });
    }

    const boostPads = [];
    const padStep = Math.max(8, Math.floor(checkpoints.length / 5));
    for (let i = Math.floor(padStep / 2); i < checkpoints.length - 2; i += padStep) {
      const point = checkpoints[i];
      boostPads.push({
        id: `pad_${i}`,
        x: point.x,
        y: point.y,
        angle: point.angle,
        w: 44,
        h: 28,
      });
    }

    const pickups = [];
    const pickupTypes = ['item_box'];
    const pickupStep = Math.max(8, Math.floor(checkpoints.length / 7));
    for (let i = 3, typeIndex = 0; i < checkpoints.length - 1; i += pickupStep, typeIndex++) {
      const point = checkpoints[i];
      const perpendicular = point.angle + Math.PI / 2;
      // Keep boxes off the racing line, but inside the usable road margin.
      // The pseudo-random lane changes per track/index without desyncing clients.
      const laneSeed = Math.abs(Math.sin((i + 1) * 12.9898 + geoTrack.id.length * 78.233));
      const side = laneSeed > 0.5 ? 1 : -1;
      const lateralRatio = 0.12 + laneSeed * 0.13;
      const lateral = side * PHY.TRACK_RENDER_HALF_WIDTH * lateralRatio;
      pickups.push({
        id: `pk_${i}`,
        type: pickupTypes[typeIndex % pickupTypes.length],
        x: Math.round(point.x + Math.cos(perpendicular) * lateral),
        y: Math.round(point.y + Math.sin(perpendicular) * lateral),
      });
    }

    return {
      id: geoTrack.id,
      name: trackConfig.name,
      color: trackConfig.color,
      theme: trackTheme(trackConfig, geoTrack),
      checkpoints,
      numCheckpoints: checkpoints.length,
      startPositions,
      boostPads,
      pickups,
      roadHalfWidth: PHY.TRACK_RENDER_HALF_WIDTH,
      laneCount: PHY.TRACK_LANE_COUNT,
      bounds: {
        minX: bounds.minX - 200,
        minY: bounds.minY - 200,
        maxX: bounds.maxX + 200,
        maxY: bounds.maxY + 200,
      },
    };
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
    const row = Math.floor(i / 4);
    const col = i % 4;
    const lateralOffset = (col - 1.5) * 40;  // cols: -60, -20, +20, +60 (within ±92 half-width)
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

  // Generate arcade item boxes; the server rolls the actual power on pickup.
  const pickups = [];
  const pkStep = Math.max(8, Math.floor(smoothed.length / 7));

  for (let i = 3; i < smoothed.length - 1; i += pkStep) {
    const cp = smoothed[i];
    // Slightly offset from exact center for variety
    const perp = cp.angle + Math.PI / 2;
    const seed = Math.abs(Math.sin((i + 1) * 12.9898 + id.length * 78.233));
    const lateral = (seed > 0.5 ? 1 : -1) * PHY.TRACK_RENDER_HALF_WIDTH * (0.12 + seed * 0.13);
    pickups.push({
      id:    `pk_${i}`,
      type:  'item_box',
      x:     Math.round(cp.x + Math.cos(perp) * lateral),
      y:     Math.round(cp.y + Math.sin(perp) * lateral),
    });
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
    roadHalfWidth:  PHY.TRACK_RENDER_HALF_WIDTH,
    laneCount: PHY.TRACK_LANE_COUNT,
    theme: trackTheme(trackConfig, { id }),
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
