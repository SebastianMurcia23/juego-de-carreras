/**
 * tools/verify-bounds.js
 * Road-boundary enforcement verification for all 40 tracks.
 *
 * Tests:
 *   1. Normal speed boundary — car touching edge from various angles should stay in.
 *   2. Max speed boundary  — car at effectiveMaxSpeed in one tick should not tunnel.
 *   3. Turbo speed tunneling — car at 1.55× maxSpeed (arcade turbo) should not tunnel.
 *   4. Extreme speed tunneling — car at 3× maxSpeed should not tunnel (worst case).
 *   5. Post-collision push — car pushed by collision should not leave road.
 *
 * Uses GameRoom directly with a fake Socket.IO adapter (same pattern as verify-bots.js).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const flags  = require('../config/feature-flags');
const tracks = require('../config/tracks');
const GameRoom = require('../server/GameRoom');
const SHARED = require('../shared/constants');

const PHY = SHARED.PHYSICS;
const DT  = 1 / PHY.TICK_RATE_HZ;

// ── Fake Socket.IO adapter ────────────────────────────────────────────────────
function fakeIo() {
  return {
    to() { return { emit() {} }; },
  };
}

// ── Minimal room data ─────────────────────────────────────────────────────────
function makeRoom(track) {
  const seatToken = `bounds-${track.id}`;
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
        name: 'BoundsVerifier',
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

// ── Project a point onto a polyline segment, return nearest point + dist ──────
function nearestOnPolyline(px, py, cps) {
  const n = cps.length;
  let minDistSq = Infinity;
  let nearestX = cps[0].x;
  let nearestY = cps[0].y;
  for (let i = 0; i < n; i++) {
    const a = cps[i];
    const b = cps[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / lenSq));
    const qx = a.x + t * abx;
    const qy = a.y + t * aby;
    const dSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (dSq < minDistSq) {
      minDistSq = dSq;
      nearestX = qx;
      nearestY = qy;
    }
  }
  return { nearestX, nearestY, dist: Math.sqrt(minDistSq) };
}

// ── Set car state manually (bypassing physics update) ────────────────────────
function setCarState(car, x, y, vx, vy, prevX, prevY, closestSegIdx) {
  car.x  = x;
  car.y  = y;
  car.vx = vx;
  car.vy = vy;
  car.previousX = prevX !== undefined ? prevX : x;
  car.previousY = prevY !== undefined ? prevY : y;
  car.speed = Math.sqrt(vx * vx + vy * vy);
  car.alive = true;
  car.health = PHY.MAX_HEALTH;
  if (closestSegIdx !== undefined) car.closestSegIdx = closestSegIdx;
}

// ── Sample perimeter points of the track (both inner and outer edges) ─────────
function samplePerimeterPoints(cps, roadHW, numSamples) {
  const n   = cps.length;
  const pts = [];
  const step = Math.max(1, Math.floor(n / numSamples));
  for (let i = 0; i < n; i += step) {
    const a = cps[i];
    const b = cps[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len = Math.sqrt(abx * abx + aby * aby) || 1;
    // Perpendicular (left side = inner or outer depending on track winding)
    const nx = -aby / len;
    const ny =  abx / len;
    // Both edges at fraction of roadHW (90% to stay near edge but definitely inside)
    pts.push({ x: a.x + nx * roadHW * 0.90, y: a.y + ny * roadHW * 0.90, segIdx: i });
    pts.push({ x: a.x - nx * roadHW * 0.90, y: a.y - ny * roadHW * 0.90, segIdx: i });
    // Also center
    pts.push({ x: a.x, y: a.y, segIdx: i });
  }
  return pts;
}

// ── Run all boundary tests for one track ────────────────────────────────────
function testTrack(track) {
  const roomData = makeRoom(track);
  const game     = new GameRoom(fakeIo(), `bounds-${track.id}`, roomData);
  game.state     = 'racing';

  const seatToken = `bounds-${track.id}`;
  const car       = game.cars.get(seatToken);
  const cps       = game.track.checkpoints;
  const roadHW    = game.track.roadHalfWidth || PHY.ROAD_HALF_WIDTH;
  const maxAllowed = Math.max(12, roadHW - PHY.CAR_RADIUS);

  // Representative car maxSpeed (viper_gt: stats.maxSpeed=85/100 × 450 × 1.8 = ~688 px/s)
  const carMaxSpeed = car.maxSpeed;

  const speeds = [
    { label: 'normal (200 px/s)',   speed: 200 },
    { label: 'maxSpeed',            speed: carMaxSpeed },
    { label: 'turbo (1.55×max)',    speed: carMaxSpeed * 1.55 },
    { label: 'extreme (3×max)',     speed: carMaxSpeed * 3.0 },
  ];

  const ANGLES = 8; // 8 impact angles
  const SAMPLES = 60; // sample points along track

  let totalTests = 0;
  let violations = 0;
  let worstPenetration = 0;
  let worstCase = null;

  const perimPts = samplePerimeterPoints(cps, roadHW, SAMPLES);

  for (const edgePt of perimPts) {
    for (const speedDef of speeds) {
      for (let ai = 0; ai < ANGLES; ai++) {
        const impactAngle = (ai / ANGLES) * Math.PI * 2;
        const sp = speedDef.speed;
        const vx = Math.cos(impactAngle) * sp;
        const vy = Math.sin(impactAngle) * sp;

        // Position: on the road edge, moving outward from center
        const { nearestX, nearestY } = nearestOnPolyline(edgePt.x, edgePt.y, cps);
        // The outward direction from track center
        let oDx = edgePt.x - nearestX;
        let oDy = edgePt.y - nearestY;
        const oLen = Math.sqrt(oDx * oDx + oDy * oDy) || 1;
        oDx /= oLen;
        oDy /= oLen;

        // Start the car at the edge boundary
        const startX = nearestX + oDx * maxAllowed;
        const startY = nearestY + oDy * maxAllowed;

        // After one dt step in the velocity direction
        const endX = startX + vx * DT;
        const endY = startY + vy * DT;

        setCarState(car, endX, endY, vx, vy, startX, startY, edgePt.segIdx);
        game._constrainToTrack(car);

        const { dist: distAfter } = nearestOnPolyline(car.x, car.y, cps);
        totalTests++;

        const penetration = distAfter - maxAllowed;
        if (penetration > 1.0) {  // 1 px tolerance
          violations++;
          if (penetration > worstPenetration) {
            worstPenetration = penetration;
            worstCase = {
              trackId: track.id,
              speed: speedDef.label,
              speedVal: sp,
              angle: (impactAngle * 180 / Math.PI).toFixed(1),
              distAfter: distAfter.toFixed(2),
              maxAllowed: maxAllowed.toFixed(2),
              penetration: penetration.toFixed(2),
            };
          }
        }
        if (penetration > worstPenetration) worstPenetration = penetration;
      }
    }
  }

  // ── Test 5: Post-collision push ───────────────────────────────────────────
  // Simulate two cars at the edge being pushed apart; one may go out
  {
    const ptA = perimPts[0] || { x: cps[0].x, y: cps[0].y, segIdx: 0 };
    const ptB = perimPts[1] || { x: cps[1].x, y: cps[1].y, segIdx: 0 };

    const carA = { ...car };
    const carB = { ...car };

    setCarState(carA, ptA.x, ptA.y, 100, 0, ptA.x - 1, ptA.y, ptA.segIdx);
    setCarState(carB, ptA.x + PHY.CAR_RADIUS * 1.5, ptA.y, -100, 0, ptA.x + PHY.CAR_RADIUS * 1.5 + 1, ptA.y, ptA.segIdx);

    // Simulate overlap push (like _carCollisions does)
    const dxC = carB.x - carA.x;
    const dyC = carB.y - carA.y;
    const distC = Math.sqrt(dxC * dxC + dyC * dyC) || 1;
    const minDistC = PHY.CAR_RADIUS * 2;
    if (distC < minDistC) {
      const overlap = (minDistC - distC) / 2;
      const nxC = dxC / distC;
      const nyC = dyC / distC;
      carA.x -= nxC * overlap;
      carA.y -= nyC * overlap;
      carB.x += nxC * overlap;
      carB.y += nyC * overlap;
    }

    // Apply constrainToTrack to both
    game._constrainToTrack(carA);
    game._constrainToTrack(carB);

    for (const c of [carA, carB]) {
      const { dist: d } = nearestOnPolyline(c.x, c.y, cps);
      totalTests++;
      const pen = d - maxAllowed;
      if (pen > 1.0) {
        violations++;
        if (pen > worstPenetration) {
          worstPenetration = pen;
          worstCase = {
            trackId: track.id,
            speed: 'collision-push',
            speedVal: 0,
            angle: 'N/A',
            distAfter: d.toFixed(2),
            maxAllowed: maxAllowed.toFixed(2),
            penetration: pen.toFixed(2),
          };
        }
      }
    }
  }

  return {
    id:              track.id,
    totalTests,
    violations,
    worstPenetration: Number(worstPenetration.toFixed(2)),
    worstCase:       worstCase || null,
    roadHW,
    maxAllowed:      Number(maxAllowed.toFixed(2)),
    carMaxSpeed:     Number(carMaxSpeed.toFixed(2)),
    checkpoints:     cps.length,
    passed:          violations === 0,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  if (!flags.USE_F1_TRACKS_AND_CARS) {
    throw new Error('USE_F1_TRACKS_AND_CARS must be true');
  }

  console.log(`Testing road boundary enforcement across ${tracks.length} tracks...\n`);

  const results    = tracks.map(testTrack);
  const passed     = results.filter(r => r.passed).length;
  const failed     = results.filter(r => !r.passed).length;
  const totalTests = results.reduce((s, r) => s + r.totalTests, 0);
  const worstTrack = results.reduce((best, r) =>
    r.worstPenetration > best.worstPenetration ? r : best, results[0]);

  const summary = {
    tracks:      results.length,
    passed,
    failed,
    totalTests,
    worstPenetration: worstTrack.worstPenetration,
    worstTrack:       worstTrack.id,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, 'bounds-verification.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );

  // Per-track output
  for (const r of results) {
    const status = r.passed ? '✓ PASS' : '✗ FAIL';
    const violStr = r.violations > 0 ? ` violations=${r.violations} worst=${r.worstPenetration}px` : '';
    console.log(`  [${status}] ${r.id.padEnd(28)} cps=${String(r.checkpoints).padStart(4)} tests=${String(r.totalTests).padStart(5)}${violStr}`);
    if (r.worstCase) {
      const wc = r.worstCase;
      console.log(`            → speed=${wc.speed} angle=${wc.angle}° dist=${wc.distAfter} allowed=${wc.maxAllowed} pen=${wc.penetration}px`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Tracks:      ${results.length}`);
  console.log(`  Passed:      ${passed}`);
  console.log(`  Failed:      ${failed}`);
  console.log(`  Total tests: ${totalTests}`);
  console.log(`  Worst penetration: ${worstTrack.worstPenetration}px on track '${worstTrack.id}'`);

  if (failed > 0) {
    console.error('\n✗ Some tracks have boundary violations. See bounds-verification.json for details.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ All tracks pass road boundary enforcement.');
  }
}

main();
