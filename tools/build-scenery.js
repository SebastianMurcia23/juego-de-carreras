/**
 * Build OSM scenery data for selected circuits.
 *
 * The circuit GeoJSON is the same source used by build-tracks.js. OSM data is
 * queried through Overpass and is stored in the game's local coordinate system
 * with the same 15% track scale.
 *
 * Usage:
 *   node tools\build-scenery.js --tracks mc-1929,be-1925,sg-2008
 *
 * OSM data: © OpenStreetMap contributors, ODbL 1.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(__dirname, 'f1-circuits', 'circuits');
const OUTPUT_DIR = path.join(ROOT, 'config', 'scenery');
const TRACKS_PATH = path.join(ROOT, 'config', 'tracks-geo.json');
const PROFILES_PATH = path.join(ROOT, 'config', 'scenery-profiles.json');
const EARTH_X = 111320;
const EARTH_Y = 110540;
const TRACK_LENGTH_SCALE = 1.15;
const ROAD_HALF_WIDTH = 92;
const ROAD_MARGIN = 60;
const MAX_FEATURES = 180;
const MAX_VERTICES = 32;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const execFileAsync = promisify(execFile);
const DEFAULT_TRACKS = ['mc-1929', 'be-1925', 'sg-2008'];

const TRACKS = JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8')).tracks;
const requested = process.argv.find(arg => arg.startsWith('--tracks='));
const trackIds = requested
  ? requested.slice('--tracks='.length).split(',').map(value => value.trim()).filter(Boolean)
  : DEFAULT_TRACKS;

function fail(message) {
  throw new Error(`[scenery] ${message}`);
}

function readCircuit(trackId) {
  const file = path.join(SOURCE_DIR, `${trackId}.geojson`);
  if (!fs.existsSync(file)) {
    fail(`missing source GeoJSON ${file}; obtain it from bacinger/f1-circuits before running`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const feature = parsed.type === 'Feature' ? parsed : parsed.features && parsed.features[0];
  if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') {
    fail(`${file}: expected a LineString Feature`);
  }
  return {
    file,
    coordinates: feature.geometry.coordinates,
  };
}

function localPoint(lon, lat, originLon, originLat) {
  const cosLat = Math.cos(originLat * Math.PI / 180);
  return {
    x: (lon - originLon) * EARTH_X * cosLat * TRACK_LENGTH_SCALE,
    y: -(lat - originLat) * EARTH_Y * TRACK_LENGTH_SCALE,
  };
}

function distanceToSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq
    ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq))
    : 0;
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}

function nearestDistance(point, line) {
  let minimum = Infinity;
  for (let i = 0; i < line.length; i++) {
    minimum = Math.min(minimum, distanceToSegment(point, line[i], line[(i + 1) % line.length]));
  }
  return minimum;
}

function simplify(points) {
  if (points.length <= MAX_VERTICES) return points;
  const result = [];
  const step = (points.length - 1) / (MAX_VERTICES - 1);
  for (let i = 0; i < MAX_VERTICES; i++) result.push(points[Math.round(i * step)]);
  return result;
}

function parseHeight(tags) {
  const height = Number.parseFloat(String(tags.height || '').replace(',', '.'));
  if (Number.isFinite(height) && height > 0) return height;
  const levels = Number.parseFloat(String(tags['building:levels'] || '').replace(',', '.'));
  return Number.isFinite(levels) && levels > 0 ? Math.min(12, levels * 3.2) : 6;
}

function classify(tags) {
  if (tags.building === 'grandstand' || tags.leisure === 'stadium') return 'grandstand';
  if (tags.building === 'paddock' || tags.building === 'hangar' || tags['building:use'] === 'paddock') return 'paddock';
  if (tags.building) return 'building';
  if (tags.natural === 'water' || tags.water) return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'forest';
  if (tags.leisure === 'park' || tags.landuse === 'recreation_ground') return 'park';
  if (tags.natural === 'sand' || tags.landuse === 'heath') return 'sand';
  if (tags.landuse === 'grass' || tags.natural === 'grassland') return 'grass';
  if (tags.highway) return 'road';
  return null;
}

function queryOverpass(bbox, body) {
  const [south, west, north, east] = bbox;
  const query = `[out:json][timeout:90];
${body}(${south},${west},${north},${east});
out tags geom qt;`;
  return execFileAsync('curl.exe', [
    '-L',
    '--fail',
    '--silent',
    '--show-error',
    '--retry',
    '2',
    '--retry-all-errors',
    '--retry-delay',
    '4',
    '--max-time',
    '75',
    '-A',
    'Road-Rumble-scenery-builder/1.0',
    '--data-urlencode',
    `data=${query}`,
    OVERPASS_URL,
  ], { maxBuffer: 32 * 1024 * 1024 }).then(result => {
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`invalid Overpass response: ${error.message}`);
    }
  }).catch(error => {
    throw new Error(`Overpass request failed: ${error.message}`);
  });
}

function featureFromElement(element, origin, centerline) {
  const type = classify(element.tags || {});
  if (!type || !Array.isArray(element.geometry) || element.geometry.length < 2) return null;
  const points = element.geometry.map(point => localPoint(point.lon, point.lat, origin.lon, origin.lat));
  const intersectsRoad = points.some(point => nearestDistance(point, centerline) < ROAD_HALF_WIDTH + ROAD_MARGIN);
  if (intersectsRoad) return null;
  const reduced = simplify(points);
  return {
    id: element.id,
    type,
    height: type === 'building' || type === 'grandstand' || type === 'paddock'
      ? parseHeight(element.tags || {})
      : 0,
    tags: {
      name: element.tags && element.tags.name ? element.tags.name : undefined,
      source: 'OpenStreetMap',
    },
    geometry: reduced,
  };
}

function bboxFor(coordinates) {
  const lons = coordinates.map(point => point[0]);
  const lats = coordinates.map(point => point[1]);
  const marginLat = 500 / EARTH_Y;
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const marginLon = 500 / (EARTH_X * Math.cos(centerLat * Math.PI / 180));
  return [
    Math.min(...lats) - marginLat,
    Math.min(...lons) - marginLon,
    Math.max(...lats) + marginLat,
    Math.max(...lons) + marginLon,
  ];
}

function splitBbox(bbox) {
  const [south, west, north, east] = bbox;
  const tiles = [];
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      tiles.push([
        south + (north - south) * row / 6,
        west + (east - west) * column / 6,
        south + (north - south) * (row + 1) / 6,
        west + (east - west) * (column + 1) / 6,
      ]);
    }
  }
  return tiles;
}

function limitFeatures(features) {
  const priority = { grandstand: 0, paddock: 1, water: 2, building: 3, park: 4, forest: 5, sand: 6, grass: 7, road: 8 };
  return features
    .sort((a, b) => priority[a.type] - priority[b.type] || a.id - b.id)
    .slice(0, MAX_FEATURES);
}

async function buildTrack(trackId) {
  const track = TRACKS.find(item => item.id === trackId);
  if (!track) fail(`track ${trackId} is not in tracks-geo.json`);
  const source = readCircuit(trackId);
  const origin = { lon: source.coordinates[0][0], lat: source.coordinates[0][1] };
  const centerline = source.coordinates.map(([lon, lat]) => localPoint(lon, lat, origin.lon, origin.lat));
  const bbox = bboxFor(source.coordinates);
  const elementsById = new Map();
  for (const tile of splitBbox(bbox)) {
    for (const filter of [
      'way["building"]',
      'way["natural"~"water|wood|sand|grassland"]',
      'way["landuse"~"forest|grass|heath|recreation_ground"]',
      'way["leisure"~"park|stadium"]',
      'way["highway"~"primary|secondary|tertiary|residential|service"]',
    ]) {
      const response = await queryOverpass(tile, filter);
      for (const element of response.elements || []) {
        elementsById.set(`${element.type}/${element.id}`, element);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const features = limitFeatures(Array.from(elementsById.values())
    .map(element => featureFromElement(element, origin, centerline))
    .filter(Boolean));
  const output = {
    version: 1,
    trackId,
    source: {
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0',
      endpoint: OVERPASS_URL,
      queriedAt: new Date().toISOString(),
      circuitGeoJSON: 'bacinger/f1-circuits, MIT',
      bbox: bbox.map(value => Number(value.toFixed(7))),
    },
    transform: {
      originLon: origin.lon,
      originLat: origin.lat,
      trackLengthScale: TRACK_LENGTH_SCALE,
      roadHalfWidth: ROAD_HALF_WIDTH,
      exclusionMargin: ROAD_MARGIN,
      coordinateUnits: 'game pixels',
    },
    limits: { maxFeatures: MAX_FEATURES, maxVerticesPerFeature: MAX_VERTICES },
    features,
  };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, `${trackId}.json`), JSON.stringify(output, null, 2) + '\n');
  console.log(`${trackId}: ${features.length} features`);
}

async function main() {
  for (const trackId of trackIds) await buildTrack(trackId);
  console.log(`Generated ${trackIds.length} scenery files in ${path.relative(ROOT, OUTPUT_DIR)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
