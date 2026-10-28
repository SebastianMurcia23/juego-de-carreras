'use strict';
/**
 * server/ItemSystem.js
 * Authoritative arcade item system for Road Rumble (ARCADE_ITEMS mode).
 *
 * Manages:
 *  - Item box placement (rows of 3, ≥4 per lap)
 *  - Server-side roulette (0.9 s lock before client may use)
 *  - 6 powers: turbo, disco, misil, aceite, invencibilidad, tinta
 *  - 3 distribution modes: positional | balanced | rotation
 *  - Projectile & oil-slick simulation at 1/30 s step
 *  - Stun, hit, block events
 *
 * Units: world pixels (same as GameRoom physics).
 *   L  = car length (~65 px default)
 *   V  = fastest car maxSpeed from cars array
 */

const SHARED  = require('../shared/constants');
const EV      = SHARED.EVENTS;

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  const closestX = ax + projection * dx;
  const closestY = ay + projection * dy;
  return Math.hypot(px - closestX, py - closestY);
}

/* ── Canonical Item IDs (from shared/constants) ─────────────────────────── */
const ITEM_IDS   = SHARED.ARCADE.ITEM_IDS;   // ['turbo','disco','misil','aceite','invencibilidad','tinta']
const DIST_MODES = SHARED.ARCADE.DIST_MODES;

/* ── Probability weights by rank (0=1st, 1=2nd, 2=3rd, 3=last) ─────────── */
//  columns: turbo, disco, misil, aceite, invencibilidad, tinta
//  New weights give ALL 6 items a non-zero probability even for 1st place.
const WEIGHTS_POSITIONAL = [
  [2, 3, 1, 3.5, 1, 0.5],  // 1st  – all 6 items can appear, mostly defensive
  [3, 3, 2, 2,   1, 1  ],  // 2nd
  [3, 2, 3, 1,   2, 2  ],  // 3rd
  [4, 1, 4, 0,   3, 2  ],  // last
];

/* ── Timings / distances (in server ticks or px) ────────────────────────── */
const TICK_RATE     = 30;
const ROULETTE_SECS = 0.9;     // server rejects use before this
const BOX_RESPAWN_S = 3.0;     // seconds before box re-appears
const BOX_POP_S     = 0.25;    // pop-in animation time (visual only, sent as metadata)

// Stun parameters
const STUN_SECS     = 1.4;
const STUN_SPEED    = 0.25;    // fraction of normal speed while stunned

// Power durations / params
const TURBO_SECS      = 2.0;
const TURBO_MULT      = 1.55;
const INV_SECS        = 6.0;
const INV_SPEED_MULT  = 1.3;
const DISC_SPEED_MULT = 1.2;   // relative to fastest car V
const DISC_LIFE_S     = 7.0;
const DISC_BOUNCE_W   = 0.25;  // lateral drift fraction
const DISC_HIT_DIST   = 1.0;   // in units of L
const DISC_IMMUNE_S   = 0.8;
const MISS_SPEED_MULT = 1.5;
const MISS_LIFE_S     = 8.0;
const MISS_STEER_RATE = 4.0;   // lateral interpolation per second
const MISS_HIT_DIST   = 1.0;
const OIL_BEHIND      = 1.5;   // L behind car
const OIL_RADIUS_L    = 0.8;   // in units of L
const OIL_LIFE_S      = 14.0;
const OIL_GROW_S      = 0.25;
const OIL_IMMUNE_S    = 3.0;
const INK_SECS        = 3.0;

/* ── Box row layout: 4 rows evenly along the track, 3 boxes per row ────── */
// Fractions along the track (0..1). Will be offset into lateral lanes –1,0,+1.
const BOX_ROW_T  = [0.12, 0.37, 0.62, 0.87];
const BOX_LANES  = [-0.5, 0, 0.5]; // fraction of ROAD_HALF_WIDTH

class ItemSystem {
  /**
   * @param {object} io          Socket.IO server
   * @param {string} roomCode
   * @param {Map}    cars        reference to GameRoom.cars Map (seatToken → carState)
   * @param {object} track       track data (checkpoints, roadHalfWidth)
   * @param {number} tickRate    ticks per second (default 30)
   * @param {string} distMode    'positional' | 'balanced' | 'rotation' | null (auto)
   * @param {number} totalCars   total number of cars (humans + bots) for auto-mode decision
   */
  constructor(io, roomCode, cars, track, tickRate = TICK_RATE, distMode = null, totalCars = 1) {
    this.io        = io;
    this.roomCode  = roomCode;
    this.cars      = cars;
    this.track     = track;
    this.tickRate  = tickRate;
    this.tickCount = 0;

    // Distribution mode: auto-select if not specified
    if (!distMode) {
      distMode = totalCars >= 4 ? DIST_MODES.POSITIONAL : DIST_MODES.BALANCED;
    }
    this.distMode = distMode;
    this._rotIdx  = 0; // for rotation mode

    /** @type {Array} item box state objects */
    this.boxes = [];
    /** @type {Array} active disc projectiles */
    this.discs = [];
    /** @type {Array} active missile projectiles */
    this.missiles = [];
    /** @type {Array} active oil slicks */
    this.oils = [];

    // Pre-computed
    this.cps = track.checkpoints || [];
    this.roadHW = (track.roadHalfWidth || 92);    // px
    this.L = 65;    // default car length in px; updated in initBoxes
    this.V = 450;   // fastest maxSpeed, updated when cars are registered

    // Reusable scratch Vector2 to avoid allocations
    this._scrX = 0;
    this._scrY = 0;
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /** Call after cars are populated so L and V are accurate. */
  initBoxes(carConfigs) {
    // Compute L from first car's dimensions (px-scale)
    if (carConfigs && carConfigs.length) {
      const firstCfg = carConfigs[0];
      if (firstCfg && firstCfg.dimensions && firstCfg.dimensions.length) {
        this.L = firstCfg.dimensions.length;
      }
      // V: max of all maxSpeed values
      this.V = 0;
      for (const [, car] of this.cars) {
        if (car.maxSpeed > this.V) this.V = car.maxSpeed;
      }
      if (this.V < 100) this.V = 450; // safety
    }

    this.boxes = [];
    let boxId = 0;
    for (const rowT of BOX_ROW_T) {
      for (const laneF of BOX_LANES) {
        const pos = this._posOnTrack(rowT, laneF * this.roadHW);
        if (!pos) continue;
        this.boxes.push({
          id:          boxId++,
          t:           rowT,
          laneF,
          x:           pos.x,
          y:           pos.y,
          active:      true,
          respawnTick: 0,
          popProgress: 1.0, // 0→1 on respawn
        });
      }
    }
  }

  /* ── Main tick called by GameRoom ──────────────────────────────────────── */
  tick(dt) {
    this.tickCount++;
    this._updateDiscs(dt);
    this._updateMissiles(dt);
    this._updateOils(dt);
    this._respawnBoxes();

    // Bots / AI use items 1 to 4 s after receiving it (and after roulette)
    for (const [, car] of this.cars) {
      if ((car.isBot || car.isAi) && car.arcadeItem && this.tickCount >= car.arcadeRollEnd) {
        if (!car.botUseItemTick) {
          car.botUseItemTick = this.tickCount + Math.round((1.0 + Math.random() * 3.0) * this.tickRate);
        } else if (this.tickCount >= car.botUseItemTick) {
          this.activateItem(car);
          car.botUseItemTick = 0;
        }
      }
    }
  }

  /* ── Player picks up a box ─────────────────────────────────────────────── */
  /**
   * Called by GameRoom when a car is near a box.
   * Returns false if nothing happened, or the item string if collected.
   */
  tryCollectBox(car) {
    if (!car.alive || car.finished) return false;
    // Already has item or rolling
    if (car.arcadeItem || car.arcadeRollEnd > this.tickCount) return false;

    const R = this.L * 1.0; // collection radius
    for (const box of this.boxes) {
      if (!box.active) continue;
      const dx = car.x - box.x;
      const dy = car.y - box.y;
      if (dx * dx + dy * dy < R * R) {
        box.active      = false;
        box.respawnTick = this.tickCount + Math.round(BOX_RESPAWN_S * this.tickRate);
        box.popProgress = 0.0;

        // Roll item immediately (server decides), lock for 0.9 s
        const item = this._rollItem(car);
        car.arcadeItem        = item;
        car.arcadeRollEnd     = this.tickCount + Math.round(ROULETTE_SECS * this.tickRate);
        car.arcadeItemHitBonus = 0;

        this.io.to(this.roomCode).emit(EV.ITEM_BOX_TAKEN, {
          seatToken: car.seatToken,
          boxId:     box.id,
          item,
        });
        // Tell the specific seat the roulette started
        this.io.to(this.roomCode).emit(EV.ITEM_ROLLING, { seatToken: car.seatToken });

        return item;
      }
    }
    return false;
  }

  /* ── Player activates stored item ─────────────────────────────────────── */
  /**
   * Called by GameRoom when player presses POWER.
   * Server rejects if roulette hasn't finished yet.
   */
  activateItem(car) {
    if (!car.arcadeItem) return false;
    if (this.tickCount < car.arcadeRollEnd) return false; // too early
    if (!car.alive || car.finished) return false;

    const item = car.arcadeItem;
    car.arcadeItem = null;

    this.io.to(this.roomCode).emit(EV.ITEM_USED, {
      seatToken: car.seatToken,
      item,
    });

    switch (item) {
      case 'turbo':          this._doTurbo(car);        break;
      case 'disco':          this._doDisc(car);          break;
      case 'misil':          this._doMissile(car);       break;
      case 'aceite':         this._doOil(car);           break;
      case 'invencibilidad': this._doInvincibility(car); break;
      case 'tinta':          this._doInk(car);           break;
    }
    return true;
  }

  /* ── Getters for GameRoom to include in broadcast ──────────────────────── */
  getStateSnapshot() {
    return {
      boxes: this.boxes.map(b => ({
        id:  b.id,
        x:   Math.round(b.x),
        y:   Math.round(b.y),
        act: b.active,
        pop: b.popProgress,
      })),
      discs: this.discs.map(d => ({
        id:  d.id,
        x:   Math.round(d.x),
        y:   Math.round(d.y),
        ang: +(d.angle.toFixed(3)),
      })),
      missiles: this.missiles.map(m => ({
        id:  m.id,
        x:   Math.round(m.x),
        y:   Math.round(m.y),
        ang: +(m.angle.toFixed(3)),
      })),
      oils: this.oils.map(o => ({
        id:   o.id,
        x:    Math.round(o.x),
        y:    Math.round(o.y),
        r:    Math.round(o.radius),
        life: +(o.life.toFixed(1)),
      })),
    };
  }

  /* ── Item implementations ──────────────────────────────────────────────── */

  _doTurbo(car) {
    car.arcadeBoostEnd = this.tickCount + Math.round(TURBO_SECS * this.tickRate);
  }

  _doInvincibility(car) {
    car.arcadeInvEnd   = this.tickCount + Math.round(INV_SECS * this.tickRate);
    car.arcadeBoostEnd = Math.max(car.arcadeBoostEnd || 0,
      this.tickCount + Math.round(INV_SECS * this.tickRate));
  }

  _doDisc(car) {
    // Disc spawns ~1.5L in front
    const cosA = Math.cos(car.angle);
    const sinA = Math.sin(car.angle);
    const spd  = this.V * DISC_SPEED_MULT;
    // Random lateral drift direction
    const driftSign = Math.random() < 0.5 ? 1 : -1;
    const lateralSpd = spd * DISC_BOUNCE_W * driftSign;

    this.discs.push({
      id:       this._nextId(),
      x:        car.x + cosA * this.L * 1.5,
      y:        car.y + sinA * this.L * 1.5,
      vx:       cosA * spd + (-sinA) * lateralSpd,
      vy:       sinA * spd + cosA    * lateralSpd,
      dvLat:    lateralSpd,   // current lateral drift velocity component
      angle:    car.angle,
      life:     DISC_LIFE_S,
      owner:    car.seatToken,
      immuneEnd: this.tickCount + Math.round(DISC_IMMUNE_S * this.tickRate),
    });
  }

  _findBestMissileTarget(car) {
    let target = null;
    let bestAhead = -1;
    let closestRival = null;
    let minD2 = Infinity;

    const myScore = (car.lap || 0) * 10000 + (car.currentCP || 0);
    for (const [, other] of this.cars) {
      if (other.seatToken === car.seatToken || !other.alive || other.finished) continue;
      const otherScore = (other.lap || 0) * 10000 + (other.currentCP || 0);
      const dx = other.x - car.x;
      const dy = other.y - car.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) {
        minD2 = d2;
        closestRival = other;
      }
      if (otherScore > myScore && (bestAhead === -1 || otherScore < bestAhead)) {
        bestAhead = otherScore;
        target = other;
      }
    }
    return target || closestRival;
  }

  _doMissile(car) {
    const target = this._findBestMissileTarget(car);
    const cosA = Math.cos(car.angle);
    const sinA = Math.sin(car.angle);
    const spd  = this.V * MISS_SPEED_MULT;
    this.missiles.push({
      id:        this._nextId(),
      x:         car.x + cosA * this.L * 1.5,
      y:         car.y + sinA * this.L * 1.5,
      vx:        cosA * spd,
      vy:        sinA * spd,
      speed:     spd,
      angle:     car.angle,
      life:      MISS_LIFE_S,
      owner:     car.seatToken,
      target:    target ? target.seatToken : null,
      immuneEnd: this.tickCount + Math.round(0.4 * this.tickRate),
    });
    if (target) {
      this.io.to(this.roomCode).emit(EV.ITEM_USED, {
        seatToken:  car.seatToken,
        item:       'misil',
        targetSeat: target.seatToken,
      });
    }
  }

  _doOil(car) {
    const cosA = Math.cos(car.angle);
    const sinA = Math.sin(car.angle);
    let ox = car.x - cosA * this.L * 1.5;
    let oy = car.y - sinA * this.L * 1.5;

    // Ensure oil spawns strictly on the road
    const nearPt = this._nearestTrackPoint(ox, oy);
    if (nearPt) {
      const latDist = this._lateralDist(ox, oy, nearPt);
      const maxLat = this.roadHW * 0.85;
      if (Math.abs(latDist) > maxLat) {
        const clampedLat = Math.sign(latDist) * maxLat;
        ox = nearPt.cx + nearPt.perp.x * clampedLat;
        oy = nearPt.cy + nearPt.perp.y * clampedLat;
      }
    }

    // Limit active oils to avoid unbounded accumulation
    if (this.oils.length >= 30) {
      this.oils.shift();
    }

    this.oils.push({
      id:        this._nextId(),
      x:         ox,
      y:         oy,
      radius:    0,
      maxRadius: this.L * OIL_RADIUS_L,
      life:      OIL_LIFE_S,
      owner:     car.seatToken,
      immuneEnd: this.tickCount + Math.round(OIL_IMMUNE_S * this.tickRate),
    });
  }

  _doInk(car) {
    // Ink: affects cars AHEAD of the user in the race
    const myScore = car.lap * 10000 + car.currentCP;
    let hitCount = 0;
    for (const [, other] of this.cars) {
      if (other.seatToken === car.seatToken || !other.alive) continue;
      const otherScore = other.lap * 10000 + other.currentCP;
      if (otherScore > myScore) {
        hitCount++;
        other.arcadeInkEnd = this.tickCount + Math.round(INK_SECS * this.tickRate);
        this.io.to(this.roomCode).emit(EV.ITEM_HIT, {
          victim:   other.seatToken,
          attacker: car.seatToken,
          item:     'tinta',
        });
      }
    }
    // If no one ahead, inform the user (not a crash but useful feedback)
    if (hitCount === 0) {
      this.io.to(this.roomCode).emit(EV.ITEM_HIT, {
        victim:   null,
        attacker: car.seatToken,
        item:     'tinta_noDest',
      });
    }
  }

  /* ── Power-state multipliers used by GameRoom._updateCar ──────────────── */
  /**
   * Returns { speedMult, stunned } for a car every tick.
   * GameRoom applies speedMult on top of the car's maxSpeed.
   */
  getCarModifiers(car) {
    let speedMult = 1.0;
    let stunned   = false;

    if (car.arcadeStunEnd && this.tickCount < car.arcadeStunEnd) {
      speedMult = STUN_SPEED;
      stunned   = true;
    }
    if (car.arcadeBoostEnd && this.tickCount < car.arcadeBoostEnd) {
      speedMult = Math.max(speedMult, TURBO_MULT);
    }
    if (car.arcadeInvEnd && this.tickCount < car.arcadeInvEnd) {
      speedMult = Math.max(speedMult, INV_SPEED_MULT);
    }

    return { speedMult, stunned };
  }

  isStunned(car) {
    return car.arcadeStunEnd && this.tickCount < car.arcadeStunEnd;
  }

  isInvincible(car) {
    return car.arcadeInvEnd && this.tickCount < car.arcadeInvEnd;
  }

  isInked(car) {
    return car.arcadeInkEnd && this.tickCount < car.arcadeInkEnd;
  }

  isBoostActive(car) {
    return car.arcadeBoostEnd && this.tickCount < car.arcadeBoostEnd;
  }

  /* ── Private simulation ─────────────────────────────────────────────────── */

  _updateDiscs(dt) {
    const HW = this.roadHW;
    for (let i = this.discs.length - 1; i >= 0; i--) {
      const d = this.discs[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.discs.splice(i, 1);
        continue;
      }

      const prevX = d.x;
      const prevY = d.y;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.angle += dt * 8; // spin visual

      // Bounce off road edges: find nearest track point and lateral offset
      const nearPt = this._nearestTrackPoint(d.x, d.y);
      if (nearPt) {
        const latDist = this._lateralDist(d.x, d.y, nearPt);
        const maxLat = HW * 0.88;
        if (Math.abs(latDist) > maxLat) {
          // Clamp inside track so disc never slips out
          const clampedLat = Math.sign(latDist) * (maxLat - 1);
          d.x = nearPt.cx + nearPt.perp.x * clampedLat;
          d.y = nearPt.cy + nearPt.perp.y * clampedLat;

          // Reflect the lateral velocity component
          const perp = nearPt.perp;
          const dot = d.vx * perp.x + d.vy * perp.y;
          if (dot * Math.sign(latDist) > 0) {
            d.vx -= 2 * dot * perp.x;
            d.vy -= 2 * dot * perp.y;
          }
          d.bounces = (d.bounces || 0) + 1;
          if (d.bounces > 12) {
            this.discs.splice(i, 1);
            continue;
          }
        }
      }

      // Continuous collision detection (CCD) with sweep against cars
      const hitR = this.L * DISC_HIT_DIST;
      for (const [, car] of this.cars) {
        if (!car.alive || car.finished) continue;
        if (car.seatToken === d.owner && this.tickCount < d.immuneEnd) continue;
        const dist = pointToSegmentDistance(car.x, car.y, prevX, prevY, d.x, d.y);
        if (dist < hitR) {
          this._applyHit(car, d.owner, 'disco');
          this.discs.splice(i, 1);
          break;
        }
      }
    }
  }

  _updateMissiles(dt) {
    const HW = this.roadHW;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;
      if (m.life <= 0) {
        this.missiles.splice(i, 1);
        continue;
      }

      // 1. Target validation and re-targeting
      let tcar = m.target ? this.cars.get(m.target) : null;
      if (!tcar || !tcar.alive || tcar.finished) {
        const fallbackTarget = this._findBestMissileTarget({
          seatToken: m.owner,
          x: m.x,
          y: m.y,
          lap: 0,
          currentCP: 0,
        });
        if (fallbackTarget) {
          m.target = fallbackTarget.seatToken;
          tcar = fallbackTarget;
        } else {
          m.target = null;
          tcar = null;
        }
      }

      // 2. Navigation towards target or along track
      let targetX = m.x + m.vx;
      let targetY = m.y + m.vy;

      if (tcar) {
        const distToTarget = Math.hypot(tcar.x - m.x, tcar.y - m.y);
        if (distToTarget < this.L * 4.5 || !this.cps || this.cps.length < 2) {
          // Direct homing dive when close to the target
          targetX = tcar.x;
          targetY = tcar.y;
        } else {
          // Track-guided navigation towards target's track progression
          const nearPt = this._nearestTrackPoint(m.x, m.y);
          if (nearPt) {
            const nextIdx = (nearPt.idx + 1) % this.cps.length;
            const nextCp = this.cps[nextIdx];
            targetX = nextCp.x;
            targetY = nextCp.y;
          } else {
            targetX = tcar.x;
            targetY = tcar.y;
          }
        }
      }

      // 3. Smooth steering
      const desiredAngle = Math.atan2(targetY - m.y, targetX - m.x);
      let angleDiff = desiredAngle - m.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      const maxTurn = 6.0 * dt;
      m.angle += Math.max(-maxTurn, Math.min(maxTurn, angleDiff));

      m.vx = Math.cos(m.angle) * m.speed;
      m.vy = Math.sin(m.angle) * m.speed;

      const prevX = m.x;
      const prevY = m.y;
      m.x += m.vx * dt;
      m.y += m.vy * dt;

      // 4. Strict road boundary containment
      const trackPt = this._nearestTrackPoint(m.x, m.y);
      if (trackPt) {
        const latDist = this._lateralDist(m.x, m.y, trackPt);
        const maxLat = HW * 0.88;
        if (Math.abs(latDist) > maxLat) {
          const clampedLat = Math.sign(latDist) * (maxLat - 1);
          m.x = trackPt.cx + trackPt.perp.x * clampedLat;
          m.y = trackPt.cy + trackPt.perp.y * clampedLat;

          // Align velocity along track forward tangent so missile glides along turn
          const dotPerp = m.vx * trackPt.perp.x + m.vy * trackPt.perp.y;
          if (dotPerp * Math.sign(latDist) > 0) {
            m.vx -= dotPerp * trackPt.perp.x;
            m.vy -= dotPerp * trackPt.perp.y;
            const curSpd = Math.hypot(m.vx, m.vy) || 1;
            m.vx = (m.vx / curSpd) * m.speed;
            m.vy = (m.vy / curSpd) * m.speed;
            m.angle = Math.atan2(m.vy, m.vx);
          }
        }
      }

      // 5. Continuous collision detection (CCD) with sweep against cars
      const hitR = this.L * MISS_HIT_DIST;
      for (const [, car] of this.cars) {
        if (!car.alive || car.finished) continue;
        if (car.seatToken === m.owner && this.tickCount < m.immuneEnd) continue;
        const dist = pointToSegmentDistance(car.x, car.y, prevX, prevY, m.x, m.y);
        if (dist < hitR) {
          this._applyHit(car, m.owner, 'misil');
          this.missiles.splice(i, 1);
          break;
        }
      }
    }
  }

  _updateOils(dt) {
    for (let i = this.oils.length - 1; i >= 0; i--) {
      const o = this.oils[i];
      o.life -= dt;
      if (o.life <= 0) { this.oils.splice(i, 1); continue; }

      // Grow in first OIL_GROW_S seconds
      const growFrac = Math.min(1, (OIL_LIFE_S - o.life) / OIL_GROW_S);
      o.radius = o.maxRadius * growFrac;

      // Hit detection
      for (const [, car] of this.cars) {
        if (!car.alive || car.finished) continue;
        if (car.seatToken === o.owner && this.tickCount < o.immuneEnd) continue;
        const dx = car.x - o.x;
        const dy = car.y - o.y;
        if (dx * dx + dy * dy < (o.radius + 18) * (o.radius + 18)) {
          this._applyHit(car, o.owner, 'aceite');
          this.oils.splice(i, 1);
          break;
        }
      }
    }
  }

  _respawnBoxes() {
    for (const box of this.boxes) {
      if (!box.active && this.tickCount >= box.respawnTick) {
        box.active      = true;
        box.popProgress = 0;
      }
      if (box.active && box.popProgress < 1) {
        box.popProgress = Math.min(1, box.popProgress + 1 / (BOX_POP_S * this.tickRate));
      }
    }
  }

  /* ── Hit / stun ─────────────────────────────────────────────────────────── */

  _applyHit(car, attackerToken, itemType) {
    // Check invincibility
    if (this.tickCount < (car.arcadeInvEnd || 0)) {
      this.io.to(this.roomCode).emit(EV.ITEM_BLOCKED, {
        seatToken: car.seatToken,
        item: itemType,
      });
      return;
    }

    // Apply stun
    car.arcadeStunEnd = this.tickCount + Math.round(STUN_SECS * this.tickRate);
    // +1 point bonus for attacker
    const attacker = attackerToken ? this.cars.get(attackerToken) : null;
    if (attacker) {
      attacker.arcadeItemHitBonus = (attacker.arcadeItemHitBonus || 0) + 1;
    }

    this.io.to(this.roomCode).emit(EV.ITEM_HIT, {
      victim:   car.seatToken,
      attacker: attackerToken,
      item:     itemType,
    });
  }

  /* ── Roulette / probability ─────────────────────────────────────────────── */

  _rollItem(car) {
    switch (this.distMode) {
      case DIST_MODES.BALANCED:
        return ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];

      case DIST_MODES.ROTATION:
        return ITEM_IDS[(this._rotIdx++) % ITEM_IDS.length];

      case DIST_MODES.POSITIONAL:
      default:
        return this._rollPositional(car);
    }
  }

  _rollPositional(car) {
    // Compute rank (0 = first)
    const carArr = Array.from(this.cars.values()).filter(c => c.alive);
    carArr.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? 1 : -1;
      if (a.lap !== b.lap) return b.lap - a.lap;
      return b.currentCP - a.currentCP;
    });
    const rank = carArr.findIndex(c => c.seatToken === car.seatToken);
    // n-1 protects against single-car rooms (rank would be 0/0 = NaN)
    const n = carArr.length;
    let rankFrac;
    if (n <= 1) {
      // Only one car → use the middle row (index 1.5) so ALL items are possible
      rankFrac = 0.5;
    } else {
      rankFrac = rank < 0 ? 0 : rank / (n - 1); // 0=first, 1=last
    }

    const w = this._interpWeights(rankFrac);
    return this._weightedRandom(w);
  }

  _interpWeights(frac) {
    // frac 0..1 maps to rows 0..3
    const t    = frac * 3;
    const lo   = Math.min(3, Math.floor(t));
    const hi   = Math.min(3, lo + 1);
    const alpha = t - lo;
    const out   = [];
    for (let i = 0; i < 6; i++) {
      out.push(WEIGHTS_POSITIONAL[lo][i] * (1 - alpha) + WEIGHTS_POSITIONAL[hi][i] * alpha);
    }
    return out;
  }

  _weightedRandom(weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) return ITEM_IDS[0];
    let r = Math.random() * total;
    for (let i = 0; i < ITEM_IDS.length; i++) {
      r -= weights[i];
      if (r < 0) return ITEM_IDS[i];
    }
    return ITEM_IDS[ITEM_IDS.length - 1];
  }

  /* ── Track geometry helpers ─────────────────────────────────────────────── */

  _posOnTrack(t, lateralPx) {
    const cps = this.cps;
    if (!cps || cps.length < 2) return null;
    const idx  = Math.min(cps.length - 1, Math.floor(t * cps.length));
    const a    = cps[idx];
    const b    = cps[(idx + 1) % cps.length];
    const dx   = b.x - a.x;
    const dy   = b.y - a.y;
    const len  = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx   = -dy / len; // perpendicular (left)
    const ny   =  dx / len;
    return {
      x: a.x + nx * lateralPx,
      y: a.y + ny * lateralPx,
    };
  }

  _nearestTrackPoint(px, py) {
    const cps = this.cps;
    if (!cps || cps.length < 2) return null;
    let minD = Infinity;
    let nearIdx = 0;
    let nearProjX = cps[0].x;
    let nearProjY = cps[0].y;
    let nearPerpX = 0;
    let nearPerpY = 1;
    let nearTanX = 1;
    let nearTanY = 0;

    for (let i = 0; i < cps.length; i++) {
      const a = cps[i];
      const b = cps[(i + 1) % cps.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / lenSq));
      const projX = a.x + t * abx;
      const projY = a.y + t * aby;
      const d2 = (px - projX) * (px - projX) + (py - projY) * (py - projY);
      if (d2 < minD) {
        minD = d2;
        nearIdx = i;
        nearProjX = projX;
        nearProjY = projY;
        const len = Math.sqrt(lenSq) || 1;
        nearTanX = abx / len;
        nearTanY = aby / len;
        nearPerpX = -aby / len;
        nearPerpY =  abx / len;
      }
    }

    return {
      idx:     nearIdx,
      cx:      nearProjX,
      cy:      nearProjY,
      tangent: { x: nearTanX, y: nearTanY },
      perp:    { x: nearPerpX, y: nearPerpY },
    };
  }

  _lateralDist(px, py, nearPt) {
    const dx = px - nearPt.cx;
    const dy = py - nearPt.cy;
    return dx * nearPt.perp.x + dy * nearPt.perp.y;
  }

  clear() {
    this.discs.length = 0;
    this.missiles.length = 0;
    this.oils.length = 0;
    for (const [, car] of this.cars) {
      car.arcadeItem = null;
      car.arcadeRollEnd = 0;
      car.arcadeBoostEnd = 0;
      car.arcadeInvEnd = 0;
      car.arcadeStunEnd = 0;
      car.arcadeInkEnd = 0;
      car.arcadeItemHitBonus = 0;
      car.botUseItemTick = 0;
      car.arcadeInvHitCooldown = 0;
    }
  }

  _nextId() {
    this._idCounter = (this._idCounter || 0) + 1;
    return this._idCounter;
  }
}

module.exports = ItemSystem;
