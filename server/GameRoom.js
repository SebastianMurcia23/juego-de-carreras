/**
 * server/GameRoom.js
 * Server-authoritative game simulation for a single race.
 * Runs a fixed-timestep physics loop, processes inputs, detects collisions,
 * tracks laps/checkpoints, and broadcasts state to all clients.
 */
'use strict';

const SHARED       = require('../shared/constants');
const CARS_CONFIG  = require('../config/cars');
const WEAPONS_CFG  = require('../config/weapons');
const TRACKS_CONFIG = require('../config/tracks');
const SCORING      = require('../config/scoring');
const FLAGS        = require('../config/feature-flags');
const ItemSystem   = require('./ItemSystem');
const { generateTrack } = require('./TrackGenerator');

const EV  = SHARED.EVENTS;
const PHY = SHARED.PHYSICS;
const ARCADE = Boolean(FLAGS.ARCADE_ITEMS);

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

function segmentsIntersect(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y) {
  function ccw(p1x, p1y, p2x, p2y, p3x, p3y) {
    return (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
  }
  return ccw(a1x, a1y, b1x, b1y, b2x, b2y) !== ccw(a2x, a2y, b1x, b1y, b2x, b2y) &&
         ccw(a1x, a1y, a2x, a2y, b1x, b1y) !== ccw(a1x, a1y, a2x, a2y, b2x, b2y);
}

class GameRoom {
  /**
   * @param {object}   io          - Socket.IO server instance
   * @param {string}   roomCode    - Room identifier
   * @param {object}   roomData    - Room data from RoomManager (settings, seats)
   */
  constructor(io, roomCode, roomData) {
    this.io        = io;
    this.roomCode  = roomCode;
    this.roomData  = roomData;
    this.settings  = roomData ? roomData.settings : {};
    this.state     = 'countdown'; // 'countdown' | 'racing' | 'finished'
    this.phase     = 'preparando_pista';
    this.raceIndex = (roomData && roomData.championship) ? roomData.championship.raceNumber : 0;
    this.raceId    = `${roomCode}_race_${this.raceIndex}`;
    this.tickCount = 0;
    this.interval  = null;

    // Generate track
    const trackConfig = this._findTrack(this.settings.trackId);
    this.track = generateTrack(trackConfig, roomData.seats.size);
    this._initTrackMetrics();

    // Initialize car states from seats
    this.cars = new Map(); // seatToken → carState
    this.projectiles = []; // active projectiles
    this.mines       = []; // deployed mines
    this.pickups     = ARCADE ? [] : (this.track.pickups || []).map(p => ({
      ...p,
      active: true,
      respawnTick: 0,
    }));
    this.itemSystem  = null; // initialized after cars are populated (ARCADE mode)

    let idx = 0;
    for (const [seatToken, seat] of roomData.seats) {
      if (!seat.name) continue; // Skip seats without a linked player

      const carConfig    = this._findCar(seat.carId);
      const weaponConfig = this._findWeapon(seat.weaponId);
      const startPos     = this.track.startPositions[idx] || this.track.startPositions[0];

      this.cars.set(seatToken, {
        seatToken,
        name:          seat.name,
        isHost:        seat.isHost,
        carId:         seat.carId,
        weaponId:      seat.weaponId,

        // Position & motion
        x:             startPos.x,
        y:             startPos.y,
        previousX:     startPos.x,
        previousY:     startPos.y,
        angle:         startPos.angle,
        vx:            0,
        vy:            0,
        speed:         0,
        angularVel:    0,
        steerAngle:    0,
        steerSeq:      -1,

        // Stats (from config, normalized to physics scale)
        // Keep the catalog ratings proportional while applying the shared
        // pace multiplier to every vehicle class.
        maxSpeed:      (carConfig.stats.maxSpeed / 100) * 450 * PHY.CAR_SPEED_MULTIPLIER, // px/s
        accelMult:     carConfig.stats.acceleration / 100,
        handlingMult:  carConfig.stats.handling / 100,
        driftMult:     carConfig.stats.drift / 100,
        armorMult:     carConfig.stats.armor / 100,
        weightMult:    carConfig.stats.weight / 100,
        traction:      carConfig.stats.traction,
        color:         carConfig.color,

        // Weapon
        weaponType:    weaponConfig.type,
        weaponDamage:  weaponConfig.stats.damage,
        fireRateHz:    weaponConfig.stats.fireRateHz,
        ammo:          Math.floor(weaponConfig.stats.initialAmmo * (this.settings.ammoMultiplier || 1)),
        maxAmmo:       Math.floor(weaponConfig.stats.maxAmmo * (this.settings.ammoMultiplier || 1)),
        lastFireTick:  0,
        weaponColor:   weaponConfig.visual.projectileColor,
        projSpeed:     weaponConfig.stats.projectileSpeed,
        projRange:     weaponConfig.stats.range,
        spreadDeg:     weaponConfig.stats.spreadAngleDeg || 0,

        // Health & Shields
        health:        PHY.MAX_HEALTH,
        alive:         true,
        respawnAt:     0,
        invulnUntil:   0,
        shieldUntil:   0,
        boostUntil:    0,
        powerInvulnUntil: 0,
        slowUntil: 0,
        frenzyUntil: 0,
        lastBoostPadTick: 0,

        // Race progress & orientation tracking
        currentCP:     0,      // next checkpoint index to pass
        lap:           0,      // completed laps
        passedCPCountInLap: 0, // checkpoints passed in current lap
        lastValidCP:   0,      // last confirmed valid checkpoint passed in order
        trackProgress: null,   // scalar distance along track (lap * trackLen + dist)
        closestSegIdx: 0,      // closest centerline segment index
        wrongWayTicks: 0,      // ticks spent facing/moving wrong way
        correctWayTicks: 0,    // ticks spent moving correctly
        wrongWayActive: false, // whether wrong-way warning is active
        lastWarnedSeconds: null, // last countdown second broadcasted
        navCP:         0,      // visual navigation waypoint for autopilot once finished
        finished:      false,
        finishTime:    0,
        finishPlace:   0,
        kills:         0,
        deaths:        0,
        specialBoxes:  0,
        storedPower: null,

        // ARCADE_ITEMS state
        arcadeItem:      null,   // stored item
        arcadeRollEnd:   0,      // tick when roulette finishes
        arcadeStunEnd:   0,      // tick when stun ends
        arcadeBoostEnd:  0,      // tick when boost ends
        arcadeInvEnd:    0,      // tick when invincibility ends
        arcadeInkEnd:    0,      // tick when ink effect ends
        arcadeItemHitBonus: 0,   // hits landed this race

        // Input (from controller)
        input: {
          steer: 0,
          accel: false,
          brake: false,
          fire:  false,
          drift: false,
          power: false,
        },

        // Drift state
        drifting:     false,
        driftAngle:   0,
      });

      idx++;
    }

    this.totalLaps   = this.settings.laps || 3;
    this.raceStartTick = 0;
    this.finishOrder = [];
    this.startTime   = Date.now();
    this.tickCount   = 0;
    this.elapsedTime = 0;
    this.firstFinishedTick = null;
    this.firstFinishedTime = null;
    this.firstFinishedWallTime = null;

    // Initialize arcade item system after cars are set up
    if (ARCADE) {
      const totalCars = this.cars.size;
      const distMode  = (this.settings && this.settings.itemDistribution) || null;
      this.itemSystem = new ItemSystem(
        this.io, this.roomCode, this.cars, this.track, PHY.TICK_RATE_HZ,
        distMode, totalCars
      );
      this.itemSystem.initBoxes(CARS_CONFIG);
    }
  }

  /* ── Start the race countdown then racing loop ────────────────────────── */
  start() {
    // Send track data to all clients
    this.io.to(this.roomCode).emit(EV.TRACK_DATA, this.track);

    // Initial broadcast so clients immediately see the grid and boxes
    this._broadcastState();

    // Start physics loop
    const dt = 1 / PHY.TICK_RATE_HZ;
    if (!this.interval) {
      this.interval = setInterval(() => {
        this.tick(dt);
      }, PHY.TICK_MS);
    }

    this.startCountdown();
  }

  _setPhase(phase) {
    this.phase = phase;
    this.io.to(this.roomCode).emit(SHARED.EVENTS.PHASE_CHANGED, {
      phase,
      raceId: this.raceId,
      raceIndex: this.raceIndex,
      trackId: this.settings ? this.settings.trackId : null,
    });
  }

  /* ── Intermission mode for championship between tracks ─────────────────── */
  startIntermission(intermissionSeconds, finishPayload) {
    this.state = 'intermission';
    this._setPhase('intermision_resultados');

    // Ensure all previous projectiles and hazards are wiped clean
    if (this.itemSystem) {
      this.itemSystem.clear();
    }

    // Send new track geometry to all clients
    this.io.to(this.roomCode).emit(EV.TRACK_DATA, this.track);

    // Initial broadcast so cars and boxes on the new circuit appear immediately
    this._broadcastState();

    // Emit championship intermission event with countdown and results
    this.io.to(this.roomCode).emit(EV.CHAMPIONSHIP_INTERMISSION, {
      seconds: intermissionSeconds,
      nextTrackId: this.settings.trackId,
      nextTrackName: finishPayload.nextTrackName,
      raceNumber: finishPayload.raceNumber + 1,
      totalRaces: finishPayload.totalRaces,
      results: finishPayload.results,
      standings: finishPayload.standings,
      raceId: this.raceId,
      raceIndex: this.raceIndex,
    });

    // Start physics/broadcast loop (during intermission, cars do not move)
    const dt = 1 / PHY.TICK_RATE_HZ;
    if (!this.interval) {
      this.interval = setInterval(() => {
        this.tick(dt);
      }, PHY.TICK_MS);
    }
  }

  startCountdown() {
    this.state = 'countdown';
    this._setPhase('cuenta_regresiva');
    let countdown = PHY.COUNTDOWN_SECONDS || 3;
    this.io.to(this.roomCode).emit(EV.GAME_COUNTDOWN, {
      seconds: countdown,
      raceId: this.raceId,
      raceIndex: this.raceIndex,
    });

    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    this.countdownInterval = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        this.io.to(this.roomCode).emit(EV.GAME_COUNTDOWN, {
          seconds: countdown,
          raceId: this.raceId,
          raceIndex: this.raceIndex,
        });
      } else {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.state = 'racing';
        this.raceStartTick = this.tickCount;
        this.startTime = Date.now();
        this.io.to(this.roomCode).emit(EV.GAME_COUNTDOWN, {
          seconds: 0,
          raceId: this.raceId,
          raceIndex: this.raceIndex,
        });
        this._setPhase('en_carrera');
        console.log(`[game] Race started in room ${this.roomCode}`);
      }
    }, 1000);
  }

  /* ── Stop the game loop ───────────────────────────────────────────────── */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.itemSystem) {
      this.itemSystem.clear();
    }
    this.state = 'finished';
  }

  /* ── Receive input from a controller ──────────────────────────────────── */
  setInput(seatToken, inputs) {
    const car = this.cars.get(seatToken);
    if (!car) return;
    if (this.state !== 'racing') return;
    if (car.finished) return; // Autopilot in effect; manual controls ignored
    const hasSteerSequence = Number.isFinite(inputs.steerSeq);
    if (!hasSteerSequence || inputs.steerSeq > car.steerSeq) {
      car.input.steer = Math.max(-1, Math.min(1, Number(inputs.steer) || 0));
      if (hasSteerSequence) car.steerSeq = inputs.steerSeq;
    }
    car.input.accel = Boolean(inputs.accel);
    car.input.brake = Boolean(inputs.brake);
    car.input.fire  = Boolean(inputs.fire);
    car.input.drift = Boolean(inputs.drift);
    const activatePower = Boolean(inputs.power);
    if (activatePower && !car.input.power) {
      if (ARCADE && this.itemSystem) {
        this.itemSystem.activateItem(car);
      } else {
        this._activateStoredPower(car);
      }
    }
    car.input.power = activatePower;
  }

  setSteer(seatToken, steer, steerSeq) {
    const car = this.cars.get(seatToken);
    if (!car) return;
    if (car.finished) return;
    const sequence = Number(steerSeq);
    if (Number.isFinite(sequence) && sequence <= car.steerSeq) return;
    car.input.steer = Math.max(-1, Math.min(1, Number(steer) || 0));
    if (Number.isFinite(sequence)) car.steerSeq = sequence;
  }

  /* ── Main simulation tick ─────────────────────────────────────────────── */
  tick(dt) {
    this.tickCount++;
    this.elapsedTime += dt;
    if (ARCADE && this.itemSystem) this.itemSystem.tickCount = this.tickCount;

    if (this.state === 'racing') {
      if (!ARCADE) {
        // Classic: Update pickups respawn
        for (let i = 0; i < this.pickups.length; i++) {
          const pk = this.pickups[i];
          if (!pk.active && this.tickCount >= pk.respawnTick) {
            pk.active = true;
          }
        }
      }

      // Tick arcade item system (projectiles, oils, box respawn)
      if (ARCADE && this.itemSystem) {
        this.itemSystem.tick(dt);
      }

      // Update each car
      for (const [, car] of this.cars) {
        if (!car.alive) {
          // Check respawn
          if (this.tickCount >= car.respawnAt) {
            this._respawnCar(car);
          }
          continue;
        }
        car.previousX = car.x;
        car.previousY = car.y;
        this._updateCar(car, dt);
        this._updateTrackProgressAndOrientation(car, dt);
        this._checkCheckpoints(car);
        if (!ARCADE) this._handleFiring(car);
        // Arcade: try box collection
        if (ARCADE && this.itemSystem) this.itemSystem.tryCollectBox(car);
      }

      if (!ARCADE) {
        // Update classic projectiles
        this._updateProjectiles(dt);
      }

      // Car-car collisions
      this._carCollisions();

      // Check if race is finished
      this._checkRaceEnd();
    }

    // Broadcast state every tick
    this._broadcastState();
  }

  /* ── Car physics update ───────────────────────────────────────────────── */
  _updateCar(car, dt) {
    // Apply arcade item modifiers
    let arcadeSpeedMult = 1.0;
    let arcadeStunned   = false;
    if (ARCADE && this.itemSystem) {
      const mod = this.itemSystem.getCarModifiers(car);
      arcadeSpeedMult = mod.speedMult;
      arcadeStunned   = mod.stunned;
    }
    // If car has crossed finish line and finished race, engage autopilot
    if (car.finished) {
      if (car.navCP == null) car.navCP = car.currentCP;
      const targetCP = this.track.checkpoints[car.navCP] || this.track.checkpoints[0];
      const distToNav = Math.hypot(targetCP.x - car.x, targetCP.y - car.y);
      if (distToNav < 85) {
        car.navCP = (car.navCP + 1) % this.track.numCheckpoints;
      }
      const nextTarget = this.track.checkpoints[car.navCP] || this.track.checkpoints[0];
      const targetAngle = Math.atan2(nextTarget.y - car.y, nextTarget.x - car.x);
      let angleDiff = targetAngle - car.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      car.input.steer = Math.max(-1, Math.min(1, angleDiff * 1.8));
      car.input.accel = car.speed < 185;
      car.input.brake = car.speed > 200;
      car.input.fire  = false;
      car.input.drift = false;
      car.input.power = false;
    }

    const input = car.input;

    // Get terrain at car position
    const terrain = this._getTerrainAt(car.x, car.y);
    const terrainGrip = PHY.TERRAIN_GRIP[terrain] || 1.0;
    const tractionBonus = (car.traction[terrain] || 70) / 100;
    const grip = terrainGrip * tractionBonus;

    // ── 1. Acceleration / Braking force ──
    const isBoosting = ARCADE
      ? (this.itemSystem && this.itemSystem.isBoostActive(car))
      : (this.tickCount < car.boostUntil);
    const autoThrottle = input.accel;
    let accelForce = 0;
    const isSlowed = this.tickCount < car.slowUntil;
    if (autoThrottle) {
      accelForce = PHY.ACCEL_FORCE * car.accelMult * grip *
        (isBoosting ? 1.4 : 1.0) * (isSlowed ? PHY.POWERUP_EMP_FACTOR : 1);
    }
    if (input.brake) {
      if (car.speed > 10) {
        accelForce -= PHY.BRAKE_FORCE * grip;
      } else {
        accelForce = -PHY.REVERSE_FORCE * car.accelMult * grip;
      }
    }

    // ── 2. Steering: progressive bicycle-style turning.
    const previousCos = Math.cos(car.angle);
    const previousSin = Math.sin(car.angle);
    const forwardSpeedBeforeTurn = car.vx * previousCos + car.vy * previousSin;
    const projectedForwardSpeed = forwardSpeedBeforeTurn + accelForce * dt;
    const steeringSpeed = Math.max(
      Math.abs(forwardSpeedBeforeTurn),
      Math.abs(projectedForwardSpeed),
      input.accel ? 125 : (input.brake ? 55 : 0)
    );
    const targetSteerAngle = input.steer * PHY.MAX_STEER_ANGLE *
      Math.max(0.75, Math.min(1.15, car.handlingMult));
    const steerDelta = targetSteerAngle - car.steerAngle;
    const maxSteerChange = PHY.STEER_RESPONSE * dt;
    car.steerAngle += Math.max(-maxSteerChange, Math.min(maxSteerChange, steerDelta));
    if (Math.abs(input.steer) > 0.02 && (steeringSpeed > PHY.MIN_SPEED_TO_STEER || input.accel || input.brake)) {
      const speedRatio = Math.min(1.0, steeringSpeed / car.maxSpeed);
      const minimumTurnSpeed = input.accel ? 125 : (input.brake ? 55 : PHY.MIN_SPEED_TO_STEER);
      const turnSpeed = projectedForwardSpeed < 0
        ? -Math.max(steeringSpeed, minimumTurnSpeed)
        : Math.max(steeringSpeed, minimumTurnSpeed);
      let yawRate = (turnSpeed / PHY.WHEELBASE) * Math.tan(car.steerAngle);
      if (input.accel && Math.abs(input.steer) > 0.1) {
        // Throttle must not suppress steering. This low-speed assist also
        // keeps the car responsive while acceleration is building up.
        yawRate += input.steer * 1.15;
      }
      yawRate *= 1.0 - speedRatio * PHY.STEER_SPEED_FACTOR;
      if (car.drifting) yawRate *= PHY.DRIFT_STEER_BOOST;
      yawRate = Math.max(-PHY.STEER_SPEED, Math.min(PHY.STEER_SPEED, yawRate));
      car.angularVel = yawRate;
      car.angle += yawRate * dt;
    } else {
      car.angularVel = 0;
    }

    // ── 3. Updated facing direction vector ──
    const cosA = Math.cos(car.angle);
    const sinA = Math.sin(car.angle);

    // Apply force in car's new facing direction
    car.vx += cosA * accelForce * dt;
    car.vy += sinA * accelForce * dt;

    // ── 4. Drift mechanics ──
    if (input.drift && car.speed > 35) {
      if (!car.drifting) {
        car.drifting = true;
        car.driftAngle = car.angle;
      }
    } else {
      car.drifting = false;
    }

    // ── 5. Tire Traction Model: align world velocity with car heading ──
    const forwardSpeed = car.vx * cosA + car.vy * sinA;
    const lateralSpeed = -car.vx * sinA + car.vy * cosA;

    const latGripCoeff = car.drifting
      ? (PHY.LATERAL_GRIP_DRIFT || 0.38)
      : (PHY.LATERAL_GRIP_NORMAL || 0.88);
    const effectiveLatGrip = Math.min(0.98, latGripCoeff * grip);

    // Grip eliminates sideways slip so the car travels where it is steered
    const newLateralSpeed = lateralSpeed * Math.max(0, 1 - effectiveLatGrip * dt * 32);

    car.vx = cosA * forwardSpeed - sinA * newLateralSpeed;
    car.vy = sinA * forwardSpeed + cosA * newLateralSpeed;

    // ── Friction & Drag ──
    car.vx *= PHY.FRICTION;
    car.vy *= PHY.FRICTION;

    // Do not let the car keep drifting after the player releases the
    // controls. This also prevents the chase camera from moving by itself.
    if (!input.accel && !input.brake) {
      car.vx *= 0.78;
      car.vy *= 0.78;
      if (Math.sqrt(car.vx * car.vx + car.vy * car.vy) < 3) {
        car.vx = 0;
        car.vy = 0;
      }
    }

    const spd = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (spd > 1) {
      const drag = 1 - PHY.DRAG * spd;
      car.vx *= Math.max(0.9, drag);
      car.vy *= Math.max(0.9, drag);
    }

    // ── Speed cap ──
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    let effectiveMaxSpeed;
    if (ARCADE) {
      effectiveMaxSpeed = car.maxSpeed * arcadeSpeedMult;
    } else {
      effectiveMaxSpeed = (isBoosting ? car.maxSpeed * 1.45 : car.maxSpeed) *
        (isSlowed ? PHY.POWERUP_EMP_FACTOR : 1);
    }
    // Validate against NaN
    if (!Number.isFinite(effectiveMaxSpeed) || effectiveMaxSpeed <= 0) effectiveMaxSpeed = car.maxSpeed;
    if (car.speed > effectiveMaxSpeed) {
      const scale = effectiveMaxSpeed / car.speed;
      car.vx *= scale;
      car.vy *= scale;
      car.speed = effectiveMaxSpeed;
    }

    // ── Position update ──
    car.x += car.vx * dt;
    car.y += car.vy * dt;

    // ── Track boundary check ──
    this._constrainToTrack(car);

    // ── Boost pads collision ──
    if (this.track.boostPads) {
      for (let i = 0; i < this.track.boostPads.length; i++) {
        const pad = this.track.boostPads[i];
        const dx = car.x - pad.x;
        const dy = car.y - pad.y;
        if (Math.sqrt(dx * dx + dy * dy) < 32) {
          if (this.tickCount - car.lastBoostPadTick > Math.floor(PHY.BOOST_PAD_COOLDOWN_MS / PHY.TICK_MS)) {
            car.lastBoostPadTick = this.tickCount;
            car.boostUntil = this.tickCount + Math.floor(PHY.BOOST_PAD_DURATION_MS / 1000 * PHY.TICK_RATE_HZ);
            car.vx += Math.cos(pad.angle) * PHY.BOOST_PAD_FORCE;
            car.vy += Math.sin(pad.angle) * PHY.BOOST_PAD_FORCE;
            this.io.to(this.roomCode).emit(EV.BOOST_PAD_TRIGGERED, { seatToken: car.seatToken });
          }
          break;
        }
      }
    }

    // ── Pickups collision (classic mode only; arcade uses itemSystem.tryCollectBox) ──
    if (!ARCADE && this.pickups) {
      for (let i = 0; i < this.pickups.length; i++) {
        const pk = this.pickups[i];
        if (!pk.active) continue;
        const dx = car.x - pk.x;
        const dy = car.y - pk.y;
        if (car.storedPower) continue;
        if (Math.sqrt(dx * dx + dy * dy) < PHY.PICKUP_RADIUS + PHY.CAR_RADIUS) {
          pk.active = false;
          pk.respawnTick = this.tickCount + Math.floor(PHY.PICKUP_RESPAWN_MS / 1000 * PHY.TICK_RATE_HZ);
          const powerType = pk.type === 'item_box' ? this._rollPowerup() : pk.type;
          car.storedPower = powerType;
          car.specialBoxes++;
          this.io.to(this.roomCode).emit(EV.PICKUP_COLLECTED, {
            type:      powerType,
            stored:    true,
            name:      car.name,
            seatToken: car.seatToken,
            x:         pk.x,
            y:         pk.y,
          });
          break;
        }
      }
    }
  }

  _applyPickupEffect(car, type) {
    let effectX = car.x;
    let effectY = car.y;
    switch (type) {
      case 'repair':
        car.health = Math.min(PHY.MAX_HEALTH, car.health + PHY.REPAIR_AMOUNT);
        break;
      case 'ammo':
        car.ammo = Math.min(car.maxAmmo * 2, car.ammo + Math.round(car.maxAmmo * PHY.AMMO_RELOAD_RATIO));
        break;
      case 'shield':
        car.shieldUntil = this.tickCount + Math.floor(PHY.SHIELD_DURATION_MS / 1000 * PHY.TICK_RATE_HZ);
        break;
      case 'nitro':
        car.boostUntil = this.tickCount + Math.floor(PHY.BOOST_PAD_DURATION_MS * 1.5 / 1000 * PHY.TICK_RATE_HZ);
        car.vx += Math.cos(car.angle) * (PHY.BOOST_PAD_FORCE * 1.3);
        car.vy += Math.sin(car.angle) * (PHY.BOOST_PAD_FORCE * 1.3);
        break;
      case 'star':
        car.powerInvulnUntil = this.tickCount +
          Math.floor(PHY.POWERUP_STAR_MS / 1000 * PHY.TICK_RATE_HZ);
        car.boostUntil = Math.max(car.boostUntil,
          this.tickCount + Math.floor(PHY.POWERUP_STAR_MS / 1000 * PHY.TICK_RATE_HZ));
        break;
      case 'emp':
        for (const [, rival] of this.cars) {
          if (rival !== car && rival.alive) {
            rival.slowUntil = this.tickCount +
              Math.floor(PHY.POWERUP_EMP_MS / 1000 * PHY.TICK_RATE_HZ);
          }
        }
        break;
      case 'bomb':
        for (const [, rival] of this.cars) {
          if (rival === car || !rival.alive) continue;
          const dx = rival.x - car.x;
          const dy = rival.y - car.y;
          if (Math.hypot(dx, dy) <= PHY.POWERUP_BOMB_RADIUS &&
              this.tickCount >= rival.powerInvulnUntil) {
            rival.health -= PHY.POWERUP_BOMB_DAMAGE * (1 - rival.armorMult * 0.35);
            rival.vx += dx / Math.max(1, Math.hypot(dx, dy)) * 90;
            rival.vy += dy / Math.max(1, Math.hypot(dx, dy)) * 90;
            if (rival.health <= 0) this._eliminateCar(rival, car.seatToken);
          }
        }
        break;
      case 'banana':
        this.mines.push({
          x: car.x - Math.cos(car.angle) * 34,
          y: car.y - Math.sin(car.angle) * 34,
          owner: car.seatToken,
          damage: PHY.POWERUP_BANANA_DAMAGE,
          radius: 34,
          armTick: this.tickCount + Math.floor(PHY.TICK_RATE_HZ * 0.25),
          color: '#f4d35e',
          kind: 'banana',
          alive: true,
        });
        effectX = car.x - Math.cos(car.angle) * 34;
        effectY = car.y - Math.sin(car.angle) * 34;
        break;
      case 'lightning':
        for (const [, rival] of this.cars) {
          if (rival === car || !rival.alive) continue;
          const dx = rival.x - car.x;
          const dy = rival.y - car.y;
          if (Math.hypot(dx, dy) <= PHY.POWERUP_LIGHTNING_RADIUS &&
              this.tickCount >= rival.powerInvulnUntil) {
            rival.health -= PHY.POWERUP_LIGHTNING_DAMAGE * (1 - rival.armorMult * 0.3);
            rival.slowUntil = Math.max(rival.slowUntil,
              this.tickCount + Math.floor(PHY.POWERUP_LIGHTNING_MS / 1000 * PHY.TICK_RATE_HZ));
            if (rival.health <= 0) this._eliminateCar(rival, car.seatToken);
          }
        }
        break;
      case 'rocket':
        this.projectiles.push({
          x: car.x + Math.cos(car.angle) * 24,
          y: car.y + Math.sin(car.angle) * 24,
          vx: Math.cos(car.angle) * 260,
          vy: Math.sin(car.angle) * 260,
          owner: car.seatToken,
          damage: PHY.POWERUP_ROCKET_DAMAGE,
          life: PHY.POWERUP_ROCKET_LIFE_MS / 1000,
          color: '#ff7b00',
          radius: 8,
          explosive: true,
          homing: true,
          splashRadius: 70,
        });
        break;
      case 'frenzy':
        car.frenzyUntil = this.tickCount +
          Math.floor(PHY.POWERUP_FRENZY_MS / 1000 * PHY.TICK_RATE_HZ);
        car.boostUntil = Math.max(car.boostUntil, car.frenzyUntil);
        break;
    }
    this.io.to(this.roomCode).emit(EV.POWERUP_EFFECT, {
      type,
      seatToken: car.seatToken,
      x: effectX,
      y: effectY,
    });
  }

  _activateStoredPower(car) {
    if (!car.alive || !car.storedPower) return;
    const powerType = car.storedPower;
    car.storedPower = null;
    this._applyPickupEffect(car, powerType);
  }

  _rollPowerup() {
    const powers = [
      'repair', 'ammo', 'shield', 'nitro', 'star', 'emp', 'bomb',
      'banana', 'lightning', 'rocket', 'frenzy',
    ];
    return powers[Math.floor(Math.random() * powers.length)];
  }

  /* ── Constrain car to track road surface ──────────────────────────────── */
  _constrainToTrack(car) {
    // Find the nearest point on a centerline segment, not only the nearest
    // checkpoint. This keeps cars inside curved sections between nodes.
    let minDist = Infinity;
    const cps = this.track.checkpoints;
    let nearestX = car.x;
    let nearestY = car.y;

    for (let i = 0; i < cps.length; i++) {
      const a = cps[i];
      const b = cps[(i + 1) % cps.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lengthSq = abx * abx + aby * aby;
      const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((car.x - a.x) * abx + (car.y - a.y) * aby) / lengthSq))
        : 0;
      const pointX = a.x + abx * t;
      const pointY = a.y + aby * t;
      const dx = car.x - pointX;
      const dy = car.y - pointY;
      const d = dx * dx + dy * dy;
      if (d < minDist) {
        minDist = d;
        nearestX = pointX;
        nearestY = pointY;
      }
    }

    const dist = Math.sqrt(minDist);
    // Keep the car body inside the usable road width instead of allowing it
    // to drift through the shoulder and decorative track limits.
    // Use track.roadHalfWidth as the single physical source-of-truth (same as visual).
    const trackRoadHW = this.track.roadHalfWidth || PHY.ROAD_HALF_WIDTH;
    const maxDist = Math.max(12, trackRoadHW - PHY.CAR_RADIUS * 0.35);

    if (dist > maxDist) {
      const normalX = (car.x - nearestX) / dist;
      const normalY = (car.y - nearestY) / dist;
      car.x = nearestX + normalX * maxDist;
      car.y = nearestY + normalY * maxDist;

      // Remove only the outward velocity so the car can continue along the
      // barrier instead of being stopped or launched off the circuit.
      const outwardSpeed = car.vx * normalX + car.vy * normalY;
      if (outwardSpeed > 0) {
        car.vx -= normalX * outwardSpeed;
        car.vy -= normalY * outwardSpeed;
      }

      // Damage for hitting walls hard
      if (dist > maxDist * 1.2 && car.speed > 100) {
        car.health -= PHY.COLLISION_DAMAGE * 0.3;
        car.vx *= PHY.WALL_BOUNCE;
        car.vy *= PHY.WALL_BOUNCE;
        car.lastImpactTick = this.tickCount; // silence wrong-way for 1.5 s after wall hit
      }
    }
  }

  /* ── Track metrics and full-width gates initialization ─────────────────── */
  _initTrackMetrics() {
    const cps = this.track && this.track.checkpoints ? this.track.checkpoints : [];
    const n = cps.length;
    this.track.numCheckpoints = n;
    this.track.segmentLengths = new Float64Array(n);
    this.track.cumulativeDistances = new Float64Array(n + 1);
    this.track.gates = [];

    const roadHW = (this.track.roadHalfWidth || PHY.ROAD_HALF_WIDTH);
    // Gate half-width with 30% margin ensures even cars on curbs/shoulders are registered
    const gateHW = roadHW * 1.30;

    let totalDist = 0;
    this.track.cumulativeDistances[0] = 0;

    for (let i = 0; i < n; i++) {
      const a = cps[i];
      const b = cps[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy) || 1;
      this.track.segmentLengths[i] = segLen;
      totalDist += segLen;
      this.track.cumulativeDistances[i + 1] = totalDist;

      const angle = a.angle != null ? a.angle : Math.atan2(dy, dx);
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      const tx = Math.cos(angle);
      const ty = Math.sin(angle);

      this.track.gates.push({
        index: i,
        x: a.x,
        y: a.y,
        angle,
        tx,
        ty,
        nx,
        ny,
        hw: gateHW,
        p1: { x: a.x - nx * gateHW, y: a.y - ny * gateHW },
        p2: { x: a.x + nx * gateHW, y: a.y + ny * gateHW },
      });
    }

    this.track.totalCenterlineLength = totalDist;
  }

  /* ── Track Progress & Wrong-way orientation detection ─────────────────── */
  _updateTrackProgressAndOrientation(car, dt) {
    if (car.finished || this.state !== 'racing') return;

    const cps = this.track.checkpoints;
    const n = this.track.numCheckpoints;
    if (!cps || n === 0) return;

    const segLens = this.track.segmentLengths;
    const cumDists = this.track.cumulativeDistances;
    const totalLen = this.track.totalCenterlineLength;

    // 1. Local search for closest centerline segment around car.currentCP
    //    Window [-5, +5] to survive hairpins without jumping to a far parallel segment.
    let bestDistSq = Infinity;
    let bestSegIdx = (car.currentCP - 1 + n) % n;
    let bestT = 0;

    for (let offset = -5; offset <= 5; offset++) {
      const i = (car.currentCP + offset + n * 2) % n;
      const a = cps[i];
      const b = cps[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = segLens[i] * segLens[i];
      if (lenSq <= 0) continue;

      const t = Math.max(0, Math.min(1, ((car.x - a.x) * abx + (car.y - a.y) * aby) / lenSq));
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const dx = car.x - px;
      const dy = car.y - py;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestSegIdx = i;
        bestT = t;
      }
    }

    car.closestSegIdx = bestSegIdx;
    const currentDistAlongTrack = cumDists[bestSegIdx] + bestT * segLens[bestSegIdx];
    const prevProgress = car.trackProgress;
    const newProgress = car.lap * totalLen + currentDistAlongTrack;
    car.trackProgress = newProgress;
    let rawDelta = 0;
    if (prevProgress != null) {
      rawDelta = newProgress - prevProgress;
      // Circular wrap handling (finish line crossing forward or backward)
      while (rawDelta > totalLen * 0.5) rawDelta -= totalLen;
      while (rawDelta < -totalLen * 0.5) rawDelta += totalLen;
    }

    // 2. Exponential moving average of deltaProgress (~0.75 s at 30 Hz)
    //    Smooths out single-tick bounces from collisions or power effects.
    const EMA_ALPHA = 0.08;
    if (prevProgress == null) {
      car.deltaProgressEMA = null;
    } else if (car.deltaProgressEMA == null) {
      car.deltaProgressEMA = rawDelta;
    } else {
      car.deltaProgressEMA = car.deltaProgressEMA * (1 - EMA_ALPHA) + rawDelta * EMA_ALPHA;
    }
    const smoothedDelta = car.deltaProgressEMA || 0;

    // 3. Track tangent at best segment (canonical direction)
    const segA = cps[bestSegIdx];
    const segB = cps[(bestSegIdx + 1) % n];
    const segLen = segLens[bestSegIdx] || 1;
    const tx = (segB.x - segA.x) / segLen;
    const ty = (segB.y - segA.y) / segLen;

    // Local curvature: angle change to next segment
    const segC = cps[(bestSegIdx + 2) % n];
    const segLen2 = segLens[(bestSegIdx + 1) % n] || 1;
    const tx2 = (segC.x - segB.x) / segLen2;
    const ty2 = (segC.y - segB.y) / segLen2;
    const curvatureDot = tx * tx2 + ty * ty2; // 1=straight, <0=hairpin
    // In tight corners (curvatureDot < 0.5) use a more permissive threshold
    const moveDotThreshold = curvatureDot < 0.5 ? -0.55 : -0.35;

    // 4. Velocity dot ONLY — chassis angle causes false positives when drifting
    const speed = car.speed || 0;
    const moveDot = speed > 10 ? (car.vx * tx + car.vy * ty) / speed : 0;

    // 5. Silence conditions
    const invulnActive = this.tickCount < (car.invulnUntil || 0);
    const stunActive   = ARCADE && this.itemSystem && this.itemSystem.isStunned(car);
    const postImpact   = car.lastImpactTick && (this.tickCount - car.lastImpactTick < 45);
    const silenced = this.elapsedTime < 4.0 || speed < 40 || invulnActive || stunActive || postImpact || car.finished;

    // 6. Wrong-way: sustained velocity against tangent AND smoothed backward progress
    const isMovingWrongWay = !silenced && moveDot < moveDotThreshold && smoothedDelta < 0;

    if (isMovingWrongWay) {
      car.wrongWayTicks = (car.wrongWayTicks || 0) + 1;
      car.correctWayTicks = 0;

      // Entry hysteresis: warning after ~1.0 s (30 ticks) of sustained wrong-way
      if (car.wrongWayTicks >= 30) {
        car.wrongWayActive = true;
        const countdownTicks = car.wrongWayTicks - 30;
        // 5 seconds countdown = 150 ticks
        const secondsLeft = Math.max(0, Math.ceil((150 - countdownTicks) / PHY.TICK_RATE_HZ));

        if (car.lastWarnedSeconds !== secondsLeft) {
          car.lastWarnedSeconds = secondsLeft;
          this.io.to(this.roomCode).emit(SHARED.EVENTS.WRONG_WAY_WARNING, {
            seatToken: car.seatToken,
            secondsLeft,
          });
        }

        // 5 seconds expired without correction: respawn safely
        if (countdownTicks >= 150) {
          this._respawnWrongWayCar(car);
        }
      }
    } else {
      car.correctWayTicks = (car.correctWayTicks || 0) + 1;
      // Exit hysteresis: after ~0.67 s (20 ticks) of correct driving, clear warning
      if (car.correctWayTicks >= 20) {
        if (car.wrongWayActive) {
          car.wrongWayActive = false;
          car.lastWarnedSeconds = null;
          this.io.to(this.roomCode).emit(SHARED.EVENTS.WRONG_WAY_CLEARED, {
            seatToken: car.seatToken,
          });
        }
        car.wrongWayTicks = 0;
      }
    }
  }

  /* ── Safe respawn on wrong-way timeout ─────────────────────────────────── */
  _respawnWrongWayCar(car) {
    const n = this.track.numCheckpoints;
    const lastCPIdx = car.lastValidCP != null
      ? car.lastValidCP
      : ((car.currentCP - 1 + n) % n);
    const cp = this.track.checkpoints[lastCPIdx] || this.track.checkpoints[0];

    let spawnX = cp.x;
    let spawnY = cp.y;

    // Check overlap with active cars: displace laterally if crowded
    const roadHW = this.track.roadHalfWidth || PHY.ROAD_HALF_WIDTH;
    const nx = -Math.sin(cp.angle || 0);
    const ny = Math.cos(cp.angle || 0);
    for (const [, other] of this.cars) {
      if (other !== car && Math.hypot(other.x - spawnX, other.y - spawnY) < 40) {
        spawnX += nx * Math.min(28, roadHW * 0.4);
        spawnY += ny * Math.min(28, roadHW * 0.4);
        break;
      }
    }

    car.x = spawnX;
    car.y = spawnY;
    car.previousX = spawnX;
    car.previousY = spawnY;
    car.angle = cp.angle || 0;
    car.vx = 0;
    car.vy = 0;
    car.speed = 0;
    car.angularVel = 0;
    car.steerAngle = 0;

    // Clear wrong way state
    car.wrongWayActive = false;
    car.wrongWayTicks = 0;
    car.correctWayTicks = 0;
    car.lastWarnedSeconds = null;
    this.io.to(this.roomCode).emit(SHARED.EVENTS.WRONG_WAY_CLEARED, {
      seatToken: car.seatToken,
    });

    // Short invulnerability & clear stuns
    car.invulnUntil = this.tickCount + Math.floor(PHY.TICK_RATE_HZ * 1.5);
    car.slowUntil = 0;
    car.arcadeStunEnd = 0;
    // Reset EMA so previous backward motion doesn't persist into fresh start
    car.deltaProgressEMA = null;
    car.trackProgress = null;
    car.lastImpactTick = this.tickCount; // silence wrong-way for 1.5 s after respawn
  }

  /* ── Test crossing of full-width gate in forward direction ────────────── */
  _testGateCrossing(prevX, prevY, currX, currY, gate) {
    if (!gate) return false;

    const mvX = currX - prevX;
    const mvY = currY - prevY;
    const fwdMove = mvX * gate.tx + mvY * gate.ty;

    // 1. Line segment intersection between car movement (prev, curr) and gate line (p1, p2)
    if (segmentsIntersect(prevX, prevY, currX, currY, gate.p1.x, gate.p1.y, gate.p2.x, gate.p2.y)) {
      if (fwdMove >= -1.0) return true;
    }

    // 2. Continuous signed projection onto gate tangent plane
    const d1 = (prevX - gate.x) * gate.tx + (prevY - gate.y) * gate.ty;
    const d2 = (currX - gate.x) * gate.tx + (currY - gate.y) * gate.ty;
    if (d1 <= 4.0 && d2 >= -4.0 && (d2 - d1) > -0.01) {
      const span = d2 - d1;
      const t = Math.abs(span) > 1e-6 ? Math.max(0, Math.min(1, -d1 / span)) : 0.5;
      const crossX = prevX + mvX * t;
      const crossY = prevY + mvY * t;
      const latDist = Math.abs((crossX - gate.x) * gate.nx + (crossY - gate.y) * gate.ny);
      if (latDist <= gate.hw) {
        return true;
      }
    }

    // 3. Proximity fallback to full-width gate segment
    const distToGateSeg = pointToSegmentDistance(currX, currY, gate.p1.x, gate.p1.y, gate.p2.x, gate.p2.y);
    if (distToGateSeg < 28 && fwdMove >= -1.0) {
      return true;
    }

    return false;
  }

  /* ── Checkpoint & Lap tracking via full-width gates ───────────────────── */
  _checkCheckpoints(car) {
    if (car.finished) return;

    const n = this.track.numCheckpoints;
    const cpIdx = car.currentCP;
    const gate = this.track.gates && this.track.gates[cpIdx];
    if (!gate) return;

    const crossed = this._testGateCrossing(
      car.previousX,
      car.previousY,
      car.x,
      car.y,
      gate
    );

    if (crossed) {
      car.lastValidCP = cpIdx;
      car.currentCP = (cpIdx + 1) % n;
      car.passedCPCountInLap = (car.passedCPCountInLap || 0) + 1;

      // Lap completed when wrapping around to 0
      // after passing all required checkpoints in that lap
      if (car.currentCP === 0 && cpIdx > 0 && car.passedCPCountInLap >= n) {
        car.lap++;
        car.passedCPCountInLap = 0;
        console.log(`[game] ${car.name} completed lap ${car.lap}/${this.totalLaps} in ${this.roomCode}`);

        // Notify the player
        this._emitToSeat(car.seatToken, EV.LAP_COMPLETED, {
          lap:       car.lap,
          totalLaps: this.totalLaps,
        });

        // Check finish
        if (car.lap >= this.totalLaps) {
          car.finished    = true;
          car.finishTime  = Date.now() - this.startTime;
          car.finishPlace = this.finishOrder.length + 1;
          this.finishOrder.push({
            seatToken: car.seatToken,
            name:      car.name,
            place:     car.finishPlace,
            time:      car.finishTime,
            dnf:       false,
            kills:     car.kills,
            deaths:    car.deaths,
            specialBoxes: car.specialBoxes,
            powerHits: car.arcadeItemHitBonus || 0,
          });

          // If this is the 1st car across the line, start countdown for remaining players
          if (this.firstFinishedTick == null) {
            this.firstFinishedTick = this.tickCount;
            this.firstFinishedTime = this.elapsedTime;
            this.firstFinishedWallTime = Date.now();
            const timeoutSec = this.settings.finishTimeoutSeconds || 45;
            this.io.to(this.roomCode).emit(EV.RACE_COUNTDOWN_FINISH, {
              seconds: timeoutSec,
              firstPlaceName: car.name,
            });
            console.log(`[game] ${car.name} finished P1! DNF countdown: ${timeoutSec}s`);
          }

          this.io.to(this.roomCode).emit(EV.CAR_FINISHED, {
            seatToken: car.seatToken,
            name: car.name,
            place: car.finishPlace,
            time: car.finishTime,
          });
          console.log(`[game] ${car.name} finished P${car.finishPlace} in ${this.roomCode}`);
        }
      }
    } else {
      // Check for skipped segments: if the car crossed Gate 0 (finish line)
      // while car.currentCP !== 0 (it missed some checkpoints earlier):
      const finishGate = this.track.gates && this.track.gates[0];
      if (finishGate && cpIdx !== 0 && this._testGateCrossing(car.previousX, car.previousY, car.x, car.y, finishGate)) {
        this.io.to(this.roomCode).emit('toast', {
          seatToken: car.seatToken,
          message: `Te saltaste un tramo. Regresa al checkpoint ${cpIdx + 1}`,
        });
      }
    }
  }

  /* ── Weapon firing ────────────────────────────────────────────────────── */
  _handleFiring(car) {
    if (!car.input.fire || car.ammo <= 0) return;

    const frenzyFactor = this.tickCount < car.frenzyUntil ? 0.5 : 1;
    const ticksBetweenShots = Math.max(1, Math.floor(PHY.TICK_RATE_HZ / car.fireRateHz * frenzyFactor));
    if (this.tickCount - car.lastFireTick < ticksBetweenShots) return;

    car.lastFireTick = this.tickCount;
    car.ammo--;

    const spread = (car.spreadDeg * Math.PI / 180) * (Math.random() - 0.5);
    const angle  = car.angle + spread;

    if (car.weaponType === 'mine') {
      // Deploy mine behind the car
      this.mines.push({
        x:          car.x - Math.cos(car.angle) * 30,
        y:          car.y - Math.sin(car.angle) * 30,
        owner:      car.seatToken,
        damage:     car.weaponDamage,
        radius:     45,
        armTick:    this.tickCount + Math.floor(PHY.TICK_RATE_HZ * 0.6),
        color:      car.weaponColor,
        alive:      true,
      });
    } else if (car.weaponType === 'spread') {
      // Shotgun: multiple pellets
      const pellets = 5;
      for (let p = 0; p < pellets; p++) {
        const pSpread = (car.spreadDeg * Math.PI / 180) * (p / pellets - 0.5);
        const pAngle  = car.angle + pSpread;
        this.projectiles.push({
          x:       car.x + Math.cos(car.angle) * 20,
          y:       car.y + Math.sin(car.angle) * 20,
          vx:      Math.cos(pAngle) * car.projSpeed,
          vy:      Math.sin(pAngle) * car.projSpeed,
          owner:   car.seatToken,
          damage:  car.weaponDamage,
          life:    car.projRange / car.projSpeed, // seconds
          color:   car.weaponColor,
          radius:  3,
        });
      }
    } else {
      // Standard projectile
      this.projectiles.push({
        x:       car.x + Math.cos(angle) * 20,
        y:       car.y + Math.sin(angle) * 20,
        vx:      Math.cos(angle) * car.projSpeed + car.vx * 0.3,
        vy:      Math.sin(angle) * car.projSpeed + car.vy * 0.3,
        owner:   car.seatToken,
        damage:  car.weaponDamage,
        life:    car.projRange / car.projSpeed,
        color:   car.weaponColor,
        radius:  car.weaponType === 'explosive' ? 6 : 3,
        explosive: car.weaponType === 'explosive',
        splashRadius: car.weaponType === 'explosive' ? 90 : 0,
      });
    }
  }

  /* ── Projectile simulation ────────────────────────────────────────────── */
  _updateProjectiles(dt) {
    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.homing) {
        let target = null;
        let targetDistance = Infinity;
        for (const [, candidate] of this.cars) {
          if (candidate.seatToken === p.owner || !candidate.alive) continue;
          const distance = Math.hypot(candidate.x - p.x, candidate.y - p.y);
          if (distance < targetDistance) {
            target = candidate;
            targetDistance = distance;
          }
        }
        if (target) {
          const desiredAngle = Math.atan2(target.y - p.y, target.x - p.x);
          const currentAngle = Math.atan2(p.vy, p.vx);
          let delta = desiredAngle - currentAngle;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          const nextAngle = currentAngle + Math.max(-0.16, Math.min(0.16, delta));
          const speed = Math.max(220, Math.hypot(p.vx, p.vy));
          p.vx = Math.cos(nextAngle) * speed;
          p.vy = Math.sin(nextAngle) * speed;
        }
      }
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.life -= dt;

      if (p.life <= 0) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Check hit against cars
      for (const [, car] of this.cars) {
        if (car.seatToken === p.owner) continue; // no self-hit
        if (!car.alive) continue;
        if (this.tickCount < car.invulnUntil) continue;

        const dx = car.x - p.x;
        const dy = car.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < PHY.CAR_RADIUS + p.radius) {
          if (this.tickCount < car.powerInvulnUntil) {
            this.projectiles.splice(i, 1);
            break;
          }
          if (this.tickCount < car.shieldUntil) {
            // Shield absorbed hit!
            car.shieldUntil = 0;
            this.projectiles.splice(i, 1);
            break;
          }

          car.health -= p.damage * (1 - car.armorMult * 0.5);
          // Knockback
          const kb = p.damage * 0.5;
          car.vx += (dx / dist) * kb;
          car.vy += (dy / dist) * kb;

          this.projectiles.splice(i, 1);

          if (car.health <= 0) {
            this._eliminateCar(car, p.owner);
          }
          break;
        }
      }
    }

    // Update mines
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (!m.alive) { this.mines.splice(i, 1); continue; }
      if (this.tickCount < m.armTick) continue; // not yet armed

      for (const [, car] of this.cars) {
        if (car.seatToken === m.owner) continue;
        if (!car.alive) continue;
        if (this.tickCount < car.invulnUntil) continue;

        const dx = car.x - m.x;
        const dy = car.y - m.y;
        if (Math.sqrt(dx * dx + dy * dy) < m.radius + PHY.CAR_RADIUS) {
          if (this.tickCount < car.powerInvulnUntil) {
            m.alive = false;
            break;
          }
          if (this.tickCount < car.shieldUntil) {
            // Shield absorbed mine explosion!
            car.shieldUntil = 0;
            m.alive = false;
            break;
          }

          car.health -= m.damage * (1 - car.armorMult * 0.5);
          const distance = Math.max(1, Math.hypot(dx, dy));
          const kb = m.kind === 'banana' ? 85 : m.damage * 2;
          car.vx += (dx / distance) * kb;
          car.vy += (dy / distance) * kb;
          if (m.kind === 'banana') {
            car.slowUntil = Math.max(car.slowUntil,
              this.tickCount + Math.floor(PHY.POWERUP_BANANA_SLOW_MS / 1000 * PHY.TICK_RATE_HZ));
            car.angle += Math.PI * 0.45;
          }
          this.io.to(this.roomCode).emit(EV.POWERUP_EFFECT, {
            type: m.kind || 'bomb',
            seatToken: car.seatToken,
            x: car.x,
            y: car.y,
          });
          m.alive = false;

          if (car.health <= 0) {
            this._eliminateCar(car, m.owner);
          }
          break;
        }
      }
    }
  }

  /* ── Car-car collisions ───────────────────────────────────────────────── */
  _carCollisions() {
    const carArr = Array.from(this.cars.values()).filter(c => c.alive && !c.finished);
    for (let i = 0; i < carArr.length; i++) {
      for (let j = i + 1; j < carArr.length; j++) {
        const a = carArr[i];
        const b = carArr[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = PHY.CAR_RADIUS * 2;

        if (dist < minDist && dist > 0.1) {
          // Separate cars
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          // Elastic-ish collision based on weight
          const totalWeight = a.weightMult + b.weightMult;
          const aShare = b.weightMult / totalWeight;
          const bShare = a.weightMult / totalWeight;

          const relVx = a.vx - b.vx;
          const relVy = a.vy - b.vy;
          const dot   = relVx * nx + relVy * ny;

          if (dot > 0) {
            a.vx -= nx * dot * aShare * PHY.CAR_BOUNCE;
            a.vy -= ny * dot * aShare * PHY.CAR_BOUNCE;
            b.vx += nx * dot * bShare * PHY.CAR_BOUNCE;
            b.vy += ny * dot * bShare * PHY.CAR_BOUNCE;
            // Silence wrong-way detector briefly after car-car collision
            a.lastImpactTick = this.tickCount;
            b.lastImpactTick = this.tickCount;
          }

          if (ARCADE) {
            // In arcade mode: collisions separate and bounce.
            // If one car has invincibility active, stun the rival with cooldown.
            if (this.itemSystem) {
              const aInv = this.itemSystem.isInvincible(a);
              const bInv = this.itemSystem.isInvincible(b);
              if (aInv && !bInv && (!b.arcadeInvHitCooldown || this.tickCount > b.arcadeInvHitCooldown)) {
                b.arcadeInvHitCooldown = this.tickCount + Math.round(2.5 * PHY.TICK_RATE_HZ);
                this.itemSystem._applyHit(b, a.seatToken, 'invencibilidad');
              } else if (bInv && !aInv && (!a.arcadeInvHitCooldown || this.tickCount > a.arcadeInvHitCooldown)) {
                a.arcadeInvHitCooldown = this.tickCount + Math.round(2.5 * PHY.TICK_RATE_HZ);
                this.itemSystem._applyHit(a, b.seatToken, 'invencibilidad');
              }
            }
            continue;
          }

          // Classic mode: impact damage
          const impactSpeed = Math.abs(dot);
          if (impactSpeed > 20) {
            const dmg = PHY.COLLISION_DAMAGE * Math.max(0.35, impactSpeed / 160);
            if (this.tickCount >= a.powerInvulnUntil) {
              a.health -= dmg * (1 - a.armorMult * 0.3);
            }
            if (this.tickCount >= b.powerInvulnUntil) {
              b.health -= dmg * (1 - b.armorMult * 0.3);
            }
            if (a.health <= 0) this._eliminateCar(a, b.seatToken);
            if (b.health <= 0) this._eliminateCar(b, a.seatToken);
          }
        }
      }
    }
  }

  /* ── Elimination & Respawn ────────────────────────────────────────────── */
  _eliminateCar(car, attackerToken) {
    car.deaths++;
    const attacker = attackerToken ? this.cars.get(attackerToken) : null;
    if (attacker && attacker !== car) attacker.kills++;
    car.alive = false;
    car.health = 0;
    car.respawnAt = this.tickCount + Math.floor(PHY.TICK_RATE_HZ * (PHY.RESPAWN_TIME_MS / 1000));
    car.vx = 0;
    car.vy = 0;

    this.io.to(this.roomCode).emit(EV.PLAYER_ELIMINATED, {
      name: car.name,
      seatToken: car.seatToken,
    });
  }

  _respawnCar(car) {
    // Respawn at nearest checkpoint
    const cp = this.track.checkpoints[car.currentCP] || this.track.checkpoints[0];
    car.x = cp.x;
    car.y = cp.y;
    car.previousX = cp.x;
    car.previousY = cp.y;
    car.angle = cp.angle || 0;
    car.vx = 0;
    car.vy = 0;
    car.speed = 0;
    car.health = PHY.MAX_HEALTH;
    car.alive = true;
    car.invulnUntil = this.tickCount + Math.floor(PHY.TICK_RATE_HZ * (PHY.RESPAWN_INVULN_MS / 1000));
    car.arcadeInvEnd   = 0;
    car.arcadeBoostEnd = 0;
    car.arcadeStunEnd  = 0;
    car.arcadeInkEnd   = 0;
  }

  /* ── Get terrain at position ──────────────────────────────────────────── */
  _getTerrainAt(x, y) {
    // Find nearest checkpoint and use its terrain
    let minDist = Infinity;
    let terrain = 'asphalt';
    const cps = this.track.checkpoints;

    // Sample a subset for performance
    const step = Math.max(1, Math.floor(cps.length / 20));
    for (let i = 0; i < cps.length; i += step) {
      const cp = cps[i];
      const dx = x - cp.x;
      const dy = y - cp.y;
      const d  = dx * dx + dy * dy;
      if (d < minDist) {
        minDist = d;
        terrain = cp.terrain;
      }
    }

    return terrain;
  }

  /* ── Check if race is over ────────────────────────────────────────────── */
  _checkRaceEnd() {
    const activeCars = Array.from(this.cars.values()).filter(c => c.name);
    if (activeCars.length === 0) return;

    const allFinished = activeCars.every(c => c.finished);
    const timeoutSec = this.settings.finishTimeoutSeconds || 45;
    const timeoutTicks = Math.round(timeoutSec * PHY.TICK_RATE_HZ);
    const timeoutExpired = this.firstFinishedTick != null && (
      (this.tickCount - this.firstFinishedTick >= timeoutTicks) ||
      (this.elapsedTime - this.firstFinishedTime >= timeoutSec) ||
      (this.firstFinishedWallTime && Date.now() - this.firstFinishedWallTime >= timeoutSec * 1000)
    );

    if (allFinished || timeoutExpired) {
      this.state = 'finished';

      // Any active car that did not finish in time gets DNF, ordered by progress
      const unfinished = activeCars.filter(c => !c.finished);
      if (unfinished.length > 0) {
        unfinished.sort((a, b) => {
          if (b.lap !== a.lap) return b.lap - a.lap;
          if (b.currentCP !== a.currentCP) return b.currentCP - a.currentCP;
          const cpA = this.track.checkpoints[a.currentCP] || { x: 0, y: 0 };
          const cpB = this.track.checkpoints[b.currentCP] || { x: 0, y: 0 };
          const distA = Math.hypot(a.x - cpA.x, a.y - cpA.y);
          const distB = Math.hypot(b.x - cpB.x, b.y - cpB.y);
          return distA - distB;
        });

        for (const car of unfinished) {
          car.finished = false;
          car.dnf = true;
          car.finishPlace = this.finishOrder.length + 1;
          this.finishOrder.push({
            seatToken: car.seatToken,
            name:      car.name,
            place:     car.finishPlace,
            time:      null,
            dnf:       true,
            kills:     car.kills || 0,
            deaths:    car.deaths || 0,
            specialBoxes: car.specialBoxes || 0,
            powerHits: car.arcadeItemHitBonus || 0,
          });
          console.log(`[game] ${car.name} marked DNF at P${car.finishPlace} in ${this.roomCode}`);
        }
      }

      const raceNumber = this.roomData.championship ? (this.roomData.championship.raceNumber + 1) : 1;
      const results = this.finishOrder.map(result => ({
        ...result,
        points: this._racePoints(result),
      }));
      const standings = this._updateStandings(results);
      const trackOrder = this.settings.trackOrder || TRACKS_CONFIG.map(t => t.id);
      const totalRaces = this.settings.mode === 'championship' ? (this.settings.trackCount || trackOrder.length) : 1;
      const championshipFinished = this.settings.mode !== 'championship' ||
        (this.roomData.championship && this.roomData.championship.raceNumber >= totalRaces - 1);

      const nextTrackId = championshipFinished ? null :
        trackOrder[(this.roomData.championship ? this.roomData.championship.raceNumber : 0) + 1];
      const nextTrack = nextTrackId ? TRACKS_CONFIG.find(t => t.id === nextTrackId) : null;
      const nextTrackName = nextTrack ? (nextTrack.name + (nextTrack.year ? ` · ${nextTrack.year}` : '')) : null;

      const finishPayload = {
        results,
        standings,
        championshipFinished,
        raceNumber,
        totalRaces,
        nextTrackId,
        nextTrackName,
        intermissionSeconds: this.settings.intermissionSeconds || 12,
        allCars: this._getCarSummaries(),
      };

      this.io.to(this.roomCode).emit(EV.RACE_FINISHED, finishPayload);
      this.roomData.state = SHARED.STATES.ROOM.RESULTS;
      console.log(`[game] Race ${raceNumber}/${totalRaces} finished in ${this.roomCode}`);
      this.stop();

      if (typeof this.onFinish === 'function') {
        this.onFinish(finishPayload);
      }
    }
  }

  /* ── Broadcast current state to all clients ───────────────────────────── */
  _broadcastState() {
    const cars = [];
    for (const [, car] of this.cars) {
      const arcadeFlags = ARCADE && this.itemSystem ? {
        item:     car.arcadeItem,
        rolling:  this.tickCount < car.arcadeRollEnd,
        boost:    this.itemSystem.isBoostActive(car),
        inv:      this.itemSystem.isInvincible(car),
        stun:     this.itemSystem.isStunned(car),
        ink:      this.itemSystem.isInked(car),
      } : {};
      cars.push({
        st:    car.seatToken,
        nm:    car.name,
        x:     Math.round(car.x),
        y:     Math.round(car.y),
        a:     +(car.angle.toFixed(3)),
        spd:   Math.round(car.speed),
        hp:    Math.round(car.health),
        lap:   car.lap,
        cp:    car.currentCP,
        alive: car.alive,
        drift: car.drifting,
        fin:   car.finished,
        fp:    car.finishPlace,
        ammo:  ARCADE ? 0 : car.ammo,
        clr:   car.color,
        cid:   car.carId,
        wid:   ARCADE ? null : car.weaponId,
        inv:   ARCADE ? arcadeFlags.inv : this.tickCount < car.invulnUntil,
        shield: ARCADE ? false : this.tickCount < car.shieldUntil,
        star:  ARCADE ? arcadeFlags.inv : this.tickCount < car.powerInvulnUntil,
        slowed: ARCADE ? arcadeFlags.stun : this.tickCount < car.slowUntil,
        boost:  ARCADE ? arcadeFlags.boost : this.tickCount < car.boostUntil,
        frenzy: false,
        power: ARCADE ? car.arcadeItem : car.storedPower,
        rolling: ARCADE ? arcadeFlags.rolling : false,
        ink:    ARCADE ? arcadeFlags.ink : false,
        steer:  +car.input.steer.toFixed(2),
        steerAngle: +(car.steerAngle.toFixed(3)),
        firing: Boolean(car.input.fire),
        ww:    car.wrongWayActive ? (car.lastWarnedSeconds || 5) : 0,
        ghost: Boolean(car.finished),
        s:     car.trackProgress != null ? Math.round(car.trackProgress) : 0,
        dot:   car.moveDot != null ? +car.moveDot.toFixed(2) : 0,
        vx:    +car.vx.toFixed(1),
        vy:    +car.vy.toFixed(1),
        dirState: car.wrongWayActive ? 'warning' : 'ok',
      });
    }

    // Compute positions/rankings
    cars.sort((a, b) => {
      if (a.fin && !b.fin) return -1;
      if (!a.fin && b.fin) return 1;
      if (a.fin && b.fin) return a.fp - b.fp;
      if (a.lap !== b.lap) return b.lap - a.lap;
      return b.cp - a.cp;
    });

    for (let i = 0; i < cars.length; i++) {
      cars[i].pos = i + 1; // race position
      cars[i].pts = SCORING.positionPoints[i] || SCORING.defaultRemainingPoints;
    }

    const projs = this.projectiles.map(p => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
      c: p.color,
      r: p.radius,
      owner: p.owner,
      explosive: Boolean(p.explosive),
    }));

    const mns = this.mines.filter(m => m.alive).map(m => ({
      x:    Math.round(m.x),
      y:    Math.round(m.y),
      c:    m.color,
      k:    m.kind || 'mine',
      armed: this.tickCount >= m.armTick,
    }));

    // Arcade item state
    const arcadeState = (ARCADE && this.itemSystem)
      ? this.itemSystem.getStateSnapshot()
      : null;

    this.io.to(this.roomCode).emit(EV.GAME_STATE, {
      tick:   this.tickCount,
      state:  this.state,
      phase:  this.phase,
      raceId: this.raceId,
      raceIndex: this.raceIndex,
      cars,
      projs,
      mines:  mns,
      pickups: ARCADE ? [] : this.pickups.map(p => ({
        id:  p.id,
        t:   p.type,
        x:   p.x,
        y:   p.y,
        act: p.active,
      })),
      // Arcade item system state
      itemBoxes:   arcadeState ? arcadeState.boxes   : [],
      itemDiscs:   arcadeState ? arcadeState.discs   : [],
      itemMissiles:arcadeState ? arcadeState.missiles : [],
      itemOils:    arcadeState ? arcadeState.oils    : [],
      laps:   this.totalLaps,
      arcade: ARCADE,
    });
  }

  /* ── Emit to a specific seat's sockets ────────────────────────────────── */
  _emitToSeat(seatToken, event, data) {
    // Broadcast to the room; clients filter by their seatToken
    this.io.to(this.roomCode).emit(event, { ...data, seatToken });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  _findCar(carId) {
    return CARS_CONFIG.find(c => c.id === carId) || CARS_CONFIG[0];
  }

  _findWeapon(weaponId) {
    return WEAPONS_CFG.find(w => w.id === weaponId) || WEAPONS_CFG[0];
  }

  _findTrack(trackId) {
    const TRACKS = require('../config/tracks');
    return TRACKS.find(t => t.id === trackId) || TRACKS[0];
  }

  _getCarSummaries() {
    const result = [];
    for (const [, car] of this.cars) {
      result.push({
        seatToken:  car.seatToken,
        name:       car.name,
        carId:      car.carId,
        weaponId:   car.weaponId,
        lap:        car.lap,
        finished:   car.finished,
        finishPlace:car.finishPlace,
        finishTime: car.finishTime,
        kills:      car.kills,
        deaths:     car.deaths,
        specialBoxes: car.specialBoxes,
        health:     Math.round(car.health),
      });
    }
    return result;
  }

  _racePoints(result) {
    const position = SCORING.positionPoints[result.place - 1] ??
      SCORING.defaultRemainingPoints;
    if (ARCADE) {
      return position +
        (result.powerHits || 0) * (SCORING.pointsPerPowerHit || 1) +
        (SCORING.pointsFastestLap && result.fastestLap ? SCORING.pointsFastestLap : 0);
    }
    return position +
      result.kills * SCORING.pointsPerKill +
      result.specialBoxes * SCORING.pointsPerSpecialBox +
      (result.deaths * SCORING.penaltyPerDeath);
  }

  _updateStandings(results) {
    if (!this.roomData.championship) return results;
    const standings = this.roomData.championship.standings;
    for (const result of results) {
      const previous = standings.get(result.seatToken) || {
        seatToken: result.seatToken,
        name: result.name,
        points: 0,
        races: 0,
        wins: 0,
        podiums: 0,
        dnfs: 0,
        lastRacePlace: 99,
        kills: 0,
        deaths: 0,
      };
      previous.name = result.name;
      previous.points += result.points;
      previous.races++;
      previous.wins += result.place === 1 && !result.dnf ? 1 : 0;
      previous.podiums += result.place <= 3 && !result.dnf ? 1 : 0;
      if (result.dnf) previous.dnfs++;
      previous.lastRacePlace = result.place;
      previous.kills += result.kills;
      previous.deaths += result.deaths;
      standings.set(result.seatToken, previous);
    }
    return Array.from(standings.values()).sort((a, b) =>
      (b.points - a.points) ||
      (b.wins - a.wins) ||
      ((b.podiums || 0) - (a.podiums || 0)) ||
      ((a.lastRacePlace || 99) - (b.lastRacePlace || 99))
    ).map((entry, index) => ({ ...entry, place: index + 1 }));
  }
}

module.exports = GameRoom;
