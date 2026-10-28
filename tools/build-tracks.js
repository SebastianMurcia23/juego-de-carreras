/**
 * Build server-side track data from bacinger/f1-circuits GeoJSON files.
 *
 * Source: https://github.com/bacinger/f1-circuits
 * License: MIT. The source is unofficial and not affiliated with Formula One.
 *
 * Usage:
 *   node tools/build-tracks.js --source C:\path\to\f1-circuits\circuits
 *
 * Outputs:
 *   config/tracks-geo.json
 *   tools/track-contact-sheet.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ARG = process.argv.indexOf('--source');
const sourceDir = SOURCE_ARG >= 0
  ? process.argv[SOURCE_ARG + 1]
  : path.join(ROOT, 'tools', 'f1-circuits', 'circuits');
const outputPath = path.join(ROOT, 'config', 'tracks-geo.json');
const contactPath = path.join(__dirname, 'track-contact-sheet.html');
const catalogPath = path.join(ROOT, 'config', 'tracks.f1.js');
const allowUncertified = process.argv.includes('--enable-uncertified');

const ROAD_HALF_WIDTH = 65;
const MIN_RADIUS = ROAD_HALF_WIDTH * 1.15;
const MAX_SMOOTH_DEVIATION = 0.08;
const MAX_SCALE_MULTIPLIER = 1.5;
const TARGET_LAP_SECONDS = 14.1;
const BALANCED_SPEED = 432;
const TARGET_LENGTH_UNITS = BALANCED_SPEED * TARGET_LAP_SECONDS;
const MAX_CHECKPOINT_SPACING = 80;
const EARTH_X = 111320;
const EARTH_Y = 110540;
const THEMES = {
  desert: { terrain: 'Arena y tierra seca', gripLevel: 'Variable', color: '#ffb703' },
  urban: { terrain: 'Asfalto húmedo y metal', gripLevel: 'Medio-Alto', color: '#00f5d4' },
  forest: { terrain: 'Barro y fango (90%)', gripLevel: 'Muy Bajo', color: '#55a630' },
  mountain: { terrain: 'Roca y grava compacta', gripLevel: 'Medio', color: '#6c757d' },
  classic: { terrain: 'Asfalto puro (100%)', gripLevel: 'Alto', color: '#4361ee' },
};

function fail(message) {
  throw new Error(`[tracks] ${message}`);
}

function readGeoJSON(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const feature = parsed.type === 'Feature' ? parsed : parsed.features && parsed.features[0];
  const geometry = feature && feature.geometry;
  if (!geometry || geometry.type !== 'LineString') fail(`${file}: expected a LineString`);
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 4) {
    fail(`${file}: insufficient coordinates`);
  }
  const properties = feature.properties || parsed.properties || {};
  return { properties, coordinates: geometry.coordinates };
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function dedupe(points) {
  const result = [];
  for (const point of points) {
    if (!result.length || distance(result[result.length - 1], point) > 0.01) result.push(point);
  }
  return result;
}

function closeLoop(points) {
  const gap = distance(points[0], points[points.length - 1]);
  if (gap < 30) return { points: points.slice(0, -1), closed: true, gap };
  return { points, closed: false, gap };
}

function toLocal(coordinates) {
  const lon0 = coordinates[0][0];
  const lat0 = coordinates[0][1];
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  return coordinates.map(([lon, lat]) => ({
    x: (lon - lon0) * EARTH_X * cosLat,
    y: -(lat - lat0) * EARTH_Y,
  }));
}

function perimeter(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) total += distance(points[i], points[(i + 1) % points.length]);
  return total;
}

function scalePoints(points, scale) {
  return points.map(point => ({ x: point.x * scale, y: point.y * scale }));
}

function resampleClosed(points, count) {
  const lengths = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const length = distance(points[i], points[(i + 1) % points.length]);
    lengths.push(length);
    total += length;
  }
  const result = [];
  for (let n = 0; n < count; n++) {
    let target = total * n / count;
    let segment = 0;
    while (segment < lengths.length - 1 && target > lengths[segment]) {
      target -= lengths[segment++];
    }
    const a = points[segment];
    const b = points[(segment + 1) % points.length];
    const ratio = lengths[segment] ? target / lengths[segment] : 0;
    result.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
  }
  return result;
}

function curvatureRadius(a, b, c) {
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);
  const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  if (cross < 1e-6) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

function minRadius(points) {
  let minimum = Infinity;
  for (let i = 0; i < points.length; i++) {
    const radius = curvatureRadius(
      points[(i - 1 + points.length) % points.length],
      points[i],
      points[(i + 1) % points.length]
    );
    if (radius < minimum) minimum = radius;
  }
  return minimum;
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return Math.abs(value) < 1e-7 ? 0 : value > 0 ? 1 : 2;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function selfIntersects(points) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || (j + 1) % points.length === i || (i + 1) % points.length === j) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return true;
    }
  }
  return false;
}

function smooth(points) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    result.push({
      x: current.x * 0.72 + (previous.x + next.x) * 0.14,
      y: current.y * 0.72 + (previous.y + next.y) * 0.14,
    });
  }
  return result;
}

function themeFor(id, properties) {
  const country = String(id).split('-')[0].toLowerCase();
  const location = String(properties.Location || '').toLowerCase();
  if (['bh', 'qa', 'sa', 'ae'].includes(country)) return THEMES.desert;
  if (['mc', 'sg', 'az', 'us'].includes(country) || /city|street|urban|las vegas/.test(location)) return THEMES.urban;
  if (/japan|belgium|austria|monaco|italy|germany|france|portugal|switzerland/.test(location)) return THEMES.classic;
  if (/forest|jungle|brazil|canada/.test(location)) return THEMES.forest;
  if (/mountain|hill|altitude|spa|nurb|nürb/.test(location)) return THEMES.mountain;
  return THEMES.classic;
}

function difficulty(radius, points) {
  const tightness = Math.max(0, Math.min(1, (350 - radius) / 300));
  const density = Math.max(0, Math.min(1, points / 100));
  if (tightness > 0.7 || density > 0.85) return 'Maestro';
  if (tightness > 0.4 || density > 0.65) return 'Experto';
  if (tightness > 0.2 || density > 0.45) return 'Difícil';
  if (tightness > 0.08 || density > 0.25) return 'Media';
  return 'Principiante';
}

function buildRecord(file) {
  const { properties, coordinates } = readGeoJSON(file);
  const id = path.basename(file, '.geojson');
  const raw = toLocal(coordinates);
  const deduped = dedupe(raw);
  const closure = closeLoop(deduped);
  const realLength = perimeter(closure.points);
  const initialScale = TARGET_LENGTH_UNITS / realLength;
  let scale = initialScale;
  let points = scalePoints(closure.points, scale);
  let radius = minRadius(points);
  let smoothed = false;

  if (radius < MIN_RADIUS) {
    points = smooth(points);
    radius = minRadius(points);
    smoothed = true;
  }
  if (radius < MIN_RADIUS) {
    const multiplier = Math.min(MAX_SCALE_MULTIPLIER, MIN_RADIUS / Math.max(1, radius));
    scale *= multiplier;
    points = scalePoints(closure.points, scale);
    radius = minRadius(points);
  }

  const segmentCount = Math.max(16, Math.ceil(perimeter(points) / MAX_CHECKPOINT_SPACING));
  const checkpoints = resampleClosed(points, segmentCount);
  const crosses = selfIntersects(checkpoints);
  const geometricallyValid = closure.closed && !crosses && radius >= MIN_RADIUS;
  const enabled = allowUncertified || geometricallyValid;
  const location = String(properties.Location || id);
  const opened = Number(properties.opened) || Number(String(id).split('-')[1]) || 0;
  const theme = themeFor(id, properties);
  const reason = !closure.closed
    ? `circuito abierto; hueco ${closure.gap.toFixed(1)} m`
    : crosses
      ? 'autointersección o cruce detectado'
      : radius < MIN_RADIUS
        ? `radio mínimo ${radius.toFixed(1)} < ${MIN_RADIUS.toFixed(1)}`
        : null;

  return {
    id,
    name: `${location} · ${opened}`,
    country: id.split('-')[0].toLowerCase(),
    year: opened,
    lengthMeters: Math.round(realLength * 10) / 10,
    lengthUnits: Math.round(perimeter(checkpoints) * 10) / 10,
    scale: Number(scale.toFixed(8)),
    minRadius: Number(radius.toFixed(2)),
    checkpointsCount: checkpoints.length,
    lapsDefault: 3,
    terrain: theme.terrain,
    gripLevel: theme.gripLevel,
    difficulty: difficulty(radius, checkpoints.length),
    color: theme.color,
    enabled,
    disabledReason: enabled ? null : reason,
    validationWarning: geometricallyValid ? null : reason,
    source: 'bacinger/f1-circuits',
    geometry: checkpoints.map(point => ({
      x: Math.round(point.x * 100) / 100,
      y: Math.round(point.y * 100) / 100,
    })),
    smoothed,
  };
}

function writeContactSheet(records) {
  const width = 1200;
  const cellWidth = 240;
  const cellHeight = 170;
  const rows = Math.ceil(records.length / 5);
  const body = records.map((record, index) => {
    const col = index % 5;
    const row = Math.floor(index / 5);
    const points = record.geometry;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min(190 / Math.max(1, maxX - minX), 105 / Math.max(1, maxY - minY));
    const pathData = points.map((point, pointIndex) => {
      const x = col * cellWidth + 20 + (point.x - minX) * scale;
      const y = row * cellHeight + 42 + (point.y - minY) * scale;
      return `${pointIndex ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ') + ' Z';
    const status = record.enabled ? '#40d47e' : '#f25f5c';
    return `<path d="${pathData}" fill="none" stroke="${status}" stroke-width="2"/><text x="${col * cellWidth + 10}" y="${row * cellHeight + 16}" font-size="12">${record.name}</text><text x="${col * cellWidth + 10}" y="${row * cellHeight + 32}" font-size="10">R ${record.minRadius} · s ${record.scale} · ${record.enabled ? 'enabled' : record.disabledReason}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rows * cellHeight}" viewBox="0 0 ${width} ${rows * cellHeight}"><rect width="100%" height="100%" fill="#10151c"/><style>text{fill:#fff;font-family:Arial,sans-serif}</style>${body}</svg>`;
  fs.writeFileSync(contactPath, `<!doctype html><meta charset="utf-8"><title>Road Rumble track contact sheet</title>${svg}\n`, 'utf8');
}

function writeCatalog(records) {
  const metadata = records.map(record => {
    const copy = { ...record };
    delete copy.geometry;
    delete copy.source;
    delete copy.smoothed;
    return copy;
  });
  const source = `/**
 * Generated F1 circuit metadata.
 * Geometry is server-only in tracks-geo.json.
 * Source: bacinger/f1-circuits, MIT license; unofficial and not affiliated with Formula One.
 * Compatible with Node.js (CommonJS) and browser (window.CONFIG.TRACKS_F1).
 */
(function() {
'use strict';

const TRACKS = ${JSON.stringify(metadata, null, 2)};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TRACKS;
} else {
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.TRACKS_F1 = TRACKS;
}
})();
`;
  fs.writeFileSync(catalogPath, source, 'utf8');
}

function main() {
  if (!fs.existsSync(sourceDir)) fail(`source directory not found: ${sourceDir}`);
  const files = fs.readdirSync(sourceDir)
    .filter(name => name.endsWith('.geojson'))
    .sort()
    .map(name => path.join(sourceDir, name));
  if (!files.length) fail(`no GeoJSON files found in ${sourceDir}`);
  const records = files.map(buildRecord);
  const payload = {
    attribution: 'Circuit geometry from bacinger/f1-circuits, MIT license; unofficial and not affiliated with Formula One.',
    generatedAt: new Date().toISOString(),
    targetLengthUnits: TARGET_LENGTH_UNITS,
    roadHalfWidth: ROAD_HALF_WIDTH,
    tracks: records,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeContactSheet(records);
  writeCatalog(records);
  console.log(JSON.stringify({
    sourceDir,
    tracks: records.length,
    enabled: records.filter(record => record.enabled).length,
    disabled: records.filter(record => !record.enabled).length,
    maxCheckpoints: Math.max(...records.map(record => record.checkpointsCount)),
    outputPath,
    catalogPath,
    contactPath,
  }, null, 2));
}

main();
