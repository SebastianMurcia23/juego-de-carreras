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
const SCORING      = require('../config/scoring');
const { generateTrack } = require('./TrackGenerator');

const EV  = SHARED.EVENTS;
const PHY = SHARED.PHYSICS;

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
    this.settings  = roomData.settings;
    this.state     = 'countdown'; // 'countdown' | 'racing' | 'finished'
    this.tickCount = 0;
    this.interval  = null;

    // Generate track
    const trackConfig = this._findTrack(this.settings.trackId);
    this.track = generateTrack(trackConfig, roomData.seats.size);

    // Initialize car states from seats
    this.cars = new Map(); // seatToken → carState
    this.projectiles = []; // active projectiles
    this.mines       = []; // deployed mines
    this.pickups     = (this.track.pickups || []).map(p => ({
      ...p,
      active: true,
      respawnTick: 0,
    }));

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
        angle:         startPos.angle,
        vx:            0,
        vy:            0,
        speed:         0,
        angularVel:    0,
        steerAngle:    0,
        steerSeq:      -1,

        // Stats (from config, normalized to physics scale)
        maxSpeed:      (carConfig.stats.maxSpeed / 100) * 450,   // px/s
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
        lastBoostPadTick: 0,

        // Race progress
        currentCP:     0,      // next checkpoint index to pass
        lap:           0,      // completed laps
        finished:      false,
        finishTime:    0,
        finishPlace:   0,
        kills:         0,
        deaths:        0,
        specialBoxes:  0,

        // Input (from controller)
        input: {
          steer: 0,
          accel: false,
          brake: false,
          fire:  false,
          drift: false,
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
  }

  /* ── Start the race countdown then racing loop ────────────────────────── */
  start() {
    // Send track data to all clients
    this.io.to(this.roomCode).emit(EV.TRACK_DATA, this.track);

    // Countdown phase
    let countdown = PHY.COUNTDOWN_SECONDS;
    const countdownInterval = setInterval(() => {
      this.io.to(this.roomCode).emit(EV.GAME_COUNTDOWN, { seconds: countdown });
      countdown--;
      if (countdown < 0) {
        clearInterval(countdownInterval);
        this.state = 'racing';
        this.raceStartTick = this.tickCount;
        console.log(`[game] Race started in room ${this.roomCode}`);
      }
    }, 1000);

    // Start physics loop
    const dt = 1 / PHY.TICK_RATE_HZ;
    this.interval = setInterval(() => {
      this.tick(dt);
    }, PHY.TICK_MS);
  }

  /* ── Stop the game loop ───────────────────────────────────────────────── */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.state = 'finished';
  }

  /* ── Receive input from a controller ──────────────────────────────────── */
  setInput(seatToken, inputs) {
    const car = this.cars.get(seatToken);
    if (!car) return;
    const hasSteerSequence = Number.isFinite(inputs.steerSeq);
    if (!hasSteerSequence || inputs.steerSeq !== car.steerSeq) {
      car.input.steer = Math.max(-1, Math.min(1, Number(inputs.steer) || 0));
      if (hasSteerSequence) car.steerSeq = inputs.steerSeq;
    }
    car.input.accel = Boolean(inputs.accel);
    car.input.brake = Boolean(inputs.brake);
    car.input.fire  = Boolean(inputs.fire);
    car.input.drift = Boolean(inputs.drift);
  }

  setSteer(seatToken, steer, steerSeq) {
    const car = this.cars.get(seatToken);
    if (!car) return;
    const sequence = Number(steerSeq);
    if (Number.isFinite(sequence) && sequence <= car.steerSeq) return;
    car.input.steer = Math.max(-1, Math.min(1, Number(steer) || 0));
    if (Number.isFinite(sequence)) car.steerSeq = sequence;
  }

  /* ── Main simulation tick ─────────────────────────────────────────────── */
  tick(dt) {
    this.tickCount++;

    if (this.state === 'racing') {
      // Update pickups respawn
      for (let i = 0; i < this.pickups.length; i++) {
        const pk = this.pickups[i];
        if (!pk.active && this.tickCount >= pk.respawnTick) {
          pk.active = true;
        }
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
        this._updateCar(car, dt);
        this._checkCheckpoints(car);
        this._handleFiring(car);
      }

      // Update projectiles
      this._updateProjectiles(dt);

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
    const input = car.input;

    // Get terrain at car position
    const terrain = this._getTerrainAt(car.x, car.y);
    const terrainGrip = PHY.TERRAIN_GRIP[terrain] || 1.0;
    const tractionBonus = (car.traction[terrain] || 70) / 100;
    const grip = terrainGrip * tractionBonus;

    // ── 1. Acceleration / Braking force ──
    const isBoosting = this.tickCount < car.boostUntil;
    const autoThrottle = input.accel;
    let accelForce = 0;
    if (autoThrottle) {
      accelForce = PHY.ACCEL_FORCE * car.accelMult * grip * (isBoosting ? 1.4 : 1.0);
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
    const effectiveMaxSpeed = isBoosting ? car.maxSpeed * 1.45 : car.maxSpeed;
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

    // ── Pickups collision ──
    if (this.pickups) {
      for (let i = 0; i < this.pickups.length; i++) {
        const pk = this.pickups[i];
        if (!pk.active) continue;
        const dx = car.x - pk.x;
        const dy = car.y - pk.y;
        if (Math.sqrt(dx * dx + dy * dy) < PHY.PICKUP_RADIUS + PHY.CAR_RADIUS) {
          pk.active = false;
          pk.respawnTick = this.tickCount + Math.floor(PHY.PICKUP_RESPAWN_MS / 1000 * PHY.TICK_RATE_HZ);
          this._applyPickupEffect(car, pk.type);
          this.io.to(this.roomCode).emit(EV.PICKUP_COLLECTED, {
            type:      pk.type,
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
    }
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
    const maxDist = PHY.ROAD_HALF_WIDTH * 2.15;

    if (dist > maxDist) {
      // Softly return to the road. Do not repeatedly kill velocity at turns.
      const correction = Math.min((dist - maxDist) * 0.22, 18);
      car.x += ((nearestX - car.x) / dist) * correction;
      car.y += ((nearestY - car.y) / dist) * correction;

      // Damage for hitting walls hard
      if (dist > maxDist * 1.2 && car.speed > 100) {
        car.health -= PHY.COLLISION_DAMAGE * 0.3;
        car.vx *= PHY.WALL_BOUNCE;
        car.vy *= PHY.WALL_BOUNCE;
      }
    }
  }

  /* ── Checkpoint & Lap tracking ────────────────────────────────────────── */
  _checkCheckpoints(car) {
    if (car.finished) return;

    const cpIdx  = car.currentCP;
    const cp     = this.track.checkpoints[cpIdx];
    if (!cp) return;

    const dx = car.x - cp.x;
    const dy = car.y - cp.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < PHY.CHECKPOINT_RADIUS) {
      car.currentCP = (cpIdx + 1) % this.track.numCheckpoints;

      // Lap completed when wrapping around to 0
      if (car.currentCP === 0 && cpIdx > 0) {
        car.lap++;
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
            kills:     car.kills,
            deaths:    car.deaths,
            specialBoxes: car.specialBoxes,
          });
          console.log(`[game] ${car.name} finished P${car.finishPlace} in ${this.roomCode}`);
        }
      }
    }
  }

  /* ── Weapon firing ────────────────────────────────────────────────────── */
  _handleFiring(car) {
    if (!car.input.fire || car.ammo <= 0) return;

    const ticksBetweenShots = Math.floor(PHY.TICK_RATE_HZ / car.fireRateHz);
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
          if (this.tickCount < car.shieldUntil) {
            // Shield absorbed mine explosion!
            car.shieldUntil = 0;
            m.alive = false;
            break;
          }

          car.health -= m.damage * (1 - car.armorMult * 0.5);
          const kb = m.damage * 2;
          car.vx += (dx / Math.max(1, Math.abs(dx))) * kb;
          car.vy += (dy / Math.max(1, Math.abs(dy))) * kb;
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
    const carArr = Array.from(this.cars.values()).filter(c => c.alive);
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
          }

          // Minor collision damage
          const impactSpeed = Math.abs(dot);
          if (impactSpeed > 80) {
            const dmg = PHY.COLLISION_DAMAGE * (impactSpeed / 200);
            a.health -= dmg * (1 - a.armorMult * 0.3);
            b.health -= dmg * (1 - b.armorMult * 0.3);
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
    car.angle = cp.angle || 0;
    car.vx = 0;
    car.vy = 0;
    car.speed = 0;
    car.health = PHY.MAX_HEALTH;
    car.alive = true;
    car.invulnUntil = this.tickCount + Math.floor(PHY.TICK_RATE_HZ * (PHY.RESPAWN_INVULN_MS / 1000));
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
    const allFinished = activeCars.every(c => c.finished);

    if (allFinished && activeCars.length > 0) {
      this.state = 'finished';
      const raceNumber = this.roomData.championship.raceNumber + 1;
      const results = this.finishOrder.map(result => ({
        ...result,
        points: this._racePoints(result),
      }));
      const standings = this._updateStandings(results);
      const championshipFinished = this.settings.mode !== 'championship' ||
        this.roomData.championship.raceNumber >=
        (this.settings.trackOrder || []).length - 1;
      if (this.settings.mode === 'championship' && !championshipFinished) {
        this.roomData.championship.raceNumber++;
      }
      this.io.to(this.roomCode).emit(EV.RACE_FINISHED, {
        results,
        standings,
        championshipFinished,
        raceNumber,
        nextTrackId: championshipFinished ? null :
          (this.settings.trackOrder || [])[this.roomData.championship.raceNumber],
        allCars: this._getCarSummaries(),
      });
      this.roomData.state = SHARED.STATES.ROOM.RESULTS;
      console.log(`[game] Race finished in ${this.roomCode}`);
      this.stop();
    }
  }

  /* ── Broadcast current state to all clients ───────────────────────────── */
  _broadcastState() {
    const cars = [];
    for (const [, car] of this.cars) {
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
        ammo:  car.ammo,
        clr:   car.color,
        cid:   car.carId,
        wid:   car.weaponId,
        inv:   this.tickCount < car.invulnUntil,
        shield: this.tickCount < car.shieldUntil,
        boost:  this.tickCount < car.boostUntil,
        steer:  +car.input.steer.toFixed(2),
        steerAngle: +(car.steerAngle.toFixed(3)),
        firing: Boolean(car.input.fire),
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
      armed: this.tickCount >= m.armTick,
    }));

    this.io.to(this.roomCode).emit(EV.GAME_STATE, {
      tick:   this.tickCount,
      state:  this.state,
      cars,
      projs,
      mines:  mns,
      pickups: this.pickups.map(p => ({
        id:  p.id,
        t:   p.type,
        x:   p.x,
        y:   p.y,
        act: p.active,
      })),
      laps:   this.totalLaps,
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
    return position +
      result.kills * SCORING.pointsPerKill +
      result.specialBoxes * SCORING.pointsPerSpecialBox +
      (result.deaths * SCORING.penaltyPerDeath);
  }

  _updateStandings(results) {
    const standings = this.roomData.championship.standings;
    for (const result of results) {
      const previous = standings.get(result.seatToken) || {
        seatToken: result.seatToken,
        name: result.name,
        points: 0,
        races: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
      };
      previous.name = result.name;
      previous.points += result.points;
      previous.races++;
      previous.wins += result.place === 1 ? 1 : 0;
      previous.kills += result.kills;
      previous.deaths += result.deaths;
      standings.set(result.seatToken, previous);
    }
    return Array.from(standings.values()).sort((a, b) =>
      b.points - a.points || b.wins - a.wins || b.kills - a.kills
    ).map((entry, index) => ({ ...entry, place: index + 1 }));
  }
}

module.exports = GameRoom;
