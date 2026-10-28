/**
 * client/js/controller.js
 * Logic for the MOBILE CONTROLLER screen (controller.html) - Stage 2
 *
 * Phases:
 *   connecting → name-entry → [permission (iOS)] → mobile-selection → controller
 *
 * Features:
 *  - Mobile loadout selection (car, weapon, ready toggle) with canvas preview
 *  - DeviceOrientation for gyro steering (with iOS permission request)
 *  - Fallback steering buttons (◀▶) when gyro is unavailable
 *  - Pointer-event multitouch buttons (ACCEL / BRAKE / FIRE / DRIFT)
 *  - Calibration (⌖) and invert (⇄) controls
 *  - Dead zone, smoothing, max angle clamping
 *  - Auto-reconnect on socket disconnect
 *  - Wake Lock API to keep screen on
 *  - Screen orientation lock (landscape)
 *  - Stuck timer → RESTORE button
 */
'use strict';

const EV = window.SHARED.EVENTS;
const CARS = window.CONFIG?.CARS || [];
const WEAPONS = window.CONFIG?.WEAPONS || [];

/* ─── Gyro config ────────────────────────────────────────────────────────── */
const GYRO = {
  DEAD_ZONE:   2.5,  // degrees
  MAX_ANGLE:   28,   // degrees → maps to steer = ±1
  SMOOTH:      0.18, // Stable EMA filter for progressive cornering
  sensitivity: 'normal',
};

/* ─── State ─────────────────────────────────────────────────────────────── */
const S = {
  phase:               'connecting', // 'connecting' | 'name-entry' | 'permission' | 'mobile-selection' | 'controller' | 'error'
  controllerActivated: false,
  socket:              null,
  seatToken:           null,
  playerName:          null,
  isHost:              false,
  selectedCarIndex:    0,
  selectedWeaponId:    'vulcan_mg',
  isReady:             false,
  // Gyro / Motion
  hasGyro:         false,
  gyroGranted:     false,
  baseline:        0,
  calibratedOnce:  false,
  inverted:        false,
  smoothSteer:     0,
  steerSeq:        0,
  forceLandscape:  false,
  // Inputs
  inputs: {
    steer:  0,
    accel:  false,
    brake:  false,
    fire:   false,
    drift:  false,
    power:  false,
  },
  lastSpeed:       0,
  stuckSince:      null,
  speed:           0,
  position:        null,
  lap:             null,
  health:          100,
};

/* ─── DOM helpers ────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function showPhase(name) {
  const phases = ['connecting', 'name-entry', 'permission', 'mobile-selection', 'controller', 'error'];
  phases.forEach(p => {
    const el = $(`state-${p}`) || $(`state-${p.replace('-entry', '')}`);
    if (el) {
      el.classList.toggle('hidden', p !== name);
      el.style.display = (p === name) ? 'flex' : 'none';
    }
  });
  S.phase = name;
}

function toast(msg, type = '', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container')?.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/* ─── Seat token from URL ─────────────────────────────────────────────────── */
function getSeatToken() {
  const parts = window.location.pathname.split('/');
  return parts.pop() || parts.pop() || '';
}

/* ─── Mobile Loadout Selection UI ────────────────────────────────────────── */
function initMobileSelectionUI() {
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  $('ctrl-player-label').textContent = S.playerName || 'Piloto';

  if (ARCADE) {
    // Hide weapon selection card in mobile UI
    const weaponCards = document.querySelectorAll('#state-mobile-selection .ctrl-car-card');
    if (weaponCards.length > 1) weaponCards[1].style.display = 'none';
  }

  updateMobileCarDisplay();
  if (!ARCADE) updateMobileWeaponDisplay();
}

function updateMobileCarDisplay() {
  const car = CARS[S.selectedCarIndex];
  if (!car) return;
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  $('ctrl-car-name').textContent = car.name;
  $('ctrl-car-role').textContent = `${car.role} · ${car.tagline}`;

  const canvas = $('ctrl-car-canvas');
  if (canvas && window.CAR_RENDERER) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const weapon = ARCADE ? null : WEAPONS.find(w => w.id === S.selectedWeaponId);
    window.CAR_RENDERER.drawCar(ctx, canvas.width / 2, canvas.height / 2, car, weapon, 0, 1.1);
  }
}

function updateMobileWeaponDisplay() {
  const weapon = WEAPONS.find(w => w.id === S.selectedWeaponId) || WEAPONS[0];
  if (!weapon) return;

  $('ctrl-weapon-icon').textContent = weapon.icon;
  $('ctrl-weapon-name').textContent = weapon.name;
  $('ctrl-weapon-ammo').textContent = `${weapon.stats.initialAmmo} Balas · ${weapon.stats.difficulty}`;
  const fireLabel = $('btn-fire-weapon');
  if (fireLabel) fireLabel.textContent = weapon.name;
}

function updateConfirmationUI() {
  const btnReady = $('btn-ctrl-ready');
  const btnUnlock = $('btn-ctrl-unlock');
  const badge = $('ctrl-confirmed-badge');
  const prevBtn = $('btn-ctrl-car-prev');
  const nextBtn = $('btn-ctrl-car-next');

  if (S.isReady) {
    if (btnReady) {
      btnReady.classList.add('is-ready');
      btnReady.innerHTML = '✓ Vehículo Confirmado';
      btnReady.style.background = '#00f5d4';
      btnReady.style.color = '#000';
    }
    if (btnUnlock) btnUnlock.classList.remove('hidden');
    if (badge) badge.classList.remove('hidden');
    if (prevBtn) { prevBtn.disabled = true; prevBtn.style.opacity = '0.35'; prevBtn.style.pointerEvents = 'none'; }
    if (nextBtn) { nextBtn.disabled = true; nextBtn.style.opacity = '0.35'; nextBtn.style.pointerEvents = 'none'; }
  } else {
    if (btnReady) {
      btnReady.classList.remove('is-ready');
      btnReady.innerHTML = '🏎️ Confirmar Vehículo';
      btnReady.style.background = '';
      btnReady.style.color = '';
    }
    if (btnUnlock) btnUnlock.classList.add('hidden');
    if (badge) badge.classList.add('hidden');
    if (prevBtn) { prevBtn.disabled = false; prevBtn.style.opacity = ''; prevBtn.style.pointerEvents = ''; }
    if (nextBtn) { nextBtn.disabled = false; nextBtn.style.opacity = ''; nextBtn.style.pointerEvents = ''; }
  }
}

function selectMobileCar(delta) {
  if (S.isReady) {
    toast('Vehículo confirmado. Toca "Cambiar vehículo" para elegir otro.');
    return;
  }
  if (CARS.length === 0) return;
  S.selectedCarIndex = (S.selectedCarIndex + delta + CARS.length) % CARS.length;
  updateMobileCarDisplay();
  syncLoadoutToServer();
}

function selectMobileWeapon(delta) {
  if (S.isReady) return;
  if (WEAPONS.length === 0) return;
  const currentIdx = WEAPONS.findIndex(w => w.id === S.selectedWeaponId);
  const nextIdx = (currentIdx + delta + WEAPONS.length) % WEAPONS.length;
  S.selectedWeaponId = WEAPONS[nextIdx].id;
  updateMobileWeaponDisplay();
  updateMobileCarDisplay();
  syncLoadoutToServer();
}

function toggleMobileReady() {
  if (!S.isReady) {
    // Confirm vehicle
    syncLoadoutToServer();
    S.isReady = true;
    updateConfirmationUI();
    if (S.socket && S.seatToken) {
      S.socket.emit(EV.TOGGLE_READY, { seatToken: S.seatToken, isReady: true });
    }
    toast('✓ ¡Vehículo confirmado!', 'success', 2000);
  } else {
    // Already ready, prompt to unlock or toggle
    unlockMobileVehicle();
  }
}

function unlockMobileVehicle() {
  S.isReady = false;
  updateConfirmationUI();
  if (S.socket && S.seatToken) {
    S.socket.emit(EV.TOGGLE_READY, { seatToken: S.seatToken, isReady: false });
  }
  toast('Vehículo desbloqueado. Puedes cambiarlo.', 'info', 1800);
}

function syncLoadoutToServer() {
  if (!S.socket || !S.seatToken) return;
  const car = CARS[S.selectedCarIndex];
  if (!car) return;
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  S.socket.emit(EV.SELECT_LOADOUT, {
    seatToken: S.seatToken,
    carId: car.id,
    weaponId: ARCADE ? null : S.selectedWeaponId,
  });
}

/* ─── DeviceOrientation & Motion Gyroscope ───────────────────────────────── */

/**
 * Detects if the UI is CSS-rotated (portrait phone with forced landscape UI).
 * In this mode, the phone is physically portrait but the viewport is rotated
 * 90° by CSS, so the user holds it sideways like a steering wheel.
 */
function isUIRotatedPortrait() {
  return window.innerHeight > window.innerWidth;
}

function getOrientationAngle() {
  if (window.screen?.orientation?.angle !== undefined) {
    return window.screen.orientation.angle;
  }
  if (window.orientation !== undefined) {
    return window.orientation;
  }
  return 0;
}

/**
 * Unified tilt processing.
 * rawAngle: degrees of lateral tilt (positive = steer right, negative = steer left).
 */
function processSensorTilt(rawAngle, source) {
  S.sensorEventCount = (S.sensorEventCount || 0) + 1;

  // Calibrated angle (baseline defaults to 0 = level)
  const calibrated = rawAngle - (S.baseline || 0);
  const rawAbs     = Math.abs(calibrated);

  let rawSteer = 0;
  if (rawAbs > GYRO.DEAD_ZONE) {
    const sign = calibrated < 0 ? -1 : 1;
    const clamped = Math.min(rawAbs, GYRO.MAX_ANGLE);
    const ratio = (clamped - GYRO.DEAD_ZONE) / (GYRO.MAX_ANGLE - GYRO.DEAD_ZONE);
    rawSteer = sign * Math.pow(ratio, 0.88);
  }

  if (S.inverted) rawSteer = -rawSteer;

  // Responsive Exponential Moving Average
  const filteredSteer = S.smoothSteer + GYRO.SMOOTH * (rawSteer - S.smoothSteer);
  const maxStep = 0.075;
  const step = Math.max(-maxStep, Math.min(maxStep, filteredSteer - S.smoothSteer));
  S.smoothSteer += step;
  S.inputs.steer = Math.max(-1, Math.min(1, S.smoothSteer));
  S.steerSeq++;
  if (S.socket && S.socket.connected && S.seatToken) {
    S.socket.emit(EV.STEERING_INPUT, {
      seatToken: S.seatToken,
      steer: S.inputs.steer,
      steerSeq: S.steerSeq,
    });
  }

  updateSteerVisuals(S.inputs.steer, calibrated, source);
}

/**
 * DeviceMotion (accelerometer) handler.
 * Uses 2D in-plane atan2 gravity vector for 100% reliable, pitch-independent, domain-error-free tilt.
 */
function handleMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g) return;

  const gx = Number(g.x);
  const gy = Number(g.y);
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
  if (Math.abs(gx) < 0.01 && Math.abs(gy) < 0.01) return;

  S.hasMotionData = true;

  let rawAngle = 0;

  if (isUIRotatedPortrait()) {
    // Phone held sideways in portrait (left hand at top +Y, right hand at bottom -Y):
    // Neutral level: gravity pulls down towards +X (bottom edge of rotated UI), gy = 0.
    // Tilt left: left hand down -> gy > 0 -> rawAngle < 0 (negative = steer left).
    // Tilt right: right hand down -> gy < 0 -> rawAngle > 0 (positive = steer right).
    rawAngle = -Math.atan2(gy, Math.max(1.5, Math.abs(gx))) * (180 / Math.PI);
  } else {
    // Natural landscape:
    // Left hand at -X, Right hand at +X. Gravity pulls down towards -Y.
    // Tilt left: left hand down -> gx < 0 -> rawAngle < 0.
    // Tilt right: right hand down -> gx > 0 -> rawAngle > 0.
    const screenAngle = getOrientationAngle();
    const sign = (screenAngle === 270 || screenAngle === -90) ? -1 : 1;
    rawAngle = sign * Math.atan2(gx, Math.max(1.5, Math.abs(gy))) * (180 / Math.PI);
  }

  processSensorTilt(rawAngle, 'motion');
}

/**
 * DeviceOrientation fallback handler.
 * Only used if DeviceMotion is not supported by the device.
 */
function handleOrientation(e) {
  if (S.hasMotionData) return;
  if (e.gamma === null && e.beta === null) return;

  // In portrait CSS-rotated mode, lateral tilt around Z axis is gamma!
  const gamma = e.gamma ?? 0;
  processSensorTilt(gamma, 'orientation');
}

function updateSteerVisuals(steerVal, rawDeg, source) {
  // 1. Update top steer bar thumb
  const thumb = $('steer-thumb');
  if (thumb) {
    const pct = 50 + steerVal * 44;
    thumb.style.left = `${pct}%`;
  }

  // 2. Rotate Cockpit Tilt Horizon line with phone tilt
  const horizon = $('horizon-line');
  if (horizon) {
    const visualDeg = steerVal * 32;
    horizon.style.transform = `rotate(${visualDeg.toFixed(1)}deg)`;
  }

  // 3. Update digital degrees text in HUD
  const degEl = $('steer-deg-display');
  if (degEl) {
    const deg = Math.round(rawDeg || 0);
    const sign = deg > 0 ? '+' : '';
    degEl.textContent = `${sign}${deg}°`;
    degEl.style.color = Math.abs(steerVal) > 0.08 ? (steerVal < 0 ? 'var(--yellow)' : 'var(--pink)') : 'var(--cyan)';
  }

  // 4. Update gyro status badge with active directional feedback
  const statusEl = $('gyro-status-text');
  if (statusEl) {
    if (Math.abs(steerVal) < 0.08) {
      statusEl.textContent = 'CENTRO NIVELADO · GIRA EL CELULAR';
      statusEl.style.color = 'var(--cyan)';
    } else if (steerVal < 0) {
      statusEl.textContent = `◀ INCLINADO IZQUIERDA (${Math.round(Math.abs(steerVal) * 100)}%)`;
      statusEl.style.color = 'var(--yellow)';
    } else {
      statusEl.textContent = `INCLINADO DERECHA (${Math.round(steerVal * 100)}%) ▶`;
      statusEl.style.color = 'var(--pink)';
    }
  }

  // 5. Live diagnostic readout so user can see sensor health immediately
  const diagEl = $('sensor-diag');
  if (diagEl) {
    diagEl.textContent = `📡 SENSOR ACTIVO: ${Math.round(rawDeg || 0)}° | ${(steerVal * 100).toFixed(0)}%`;
    diagEl.style.color = Math.abs(steerVal) > 0.08 ? '#00e87a' : '#888';
  }
}

async function activateSensorsByUserGesture() {
  console.log('[sensor] activateSensorsByUserGesture called');

  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const state = await DeviceOrientationEvent.requestPermission();
      console.log('[sensor] DeviceOrientation permission:', state);
      if (state === 'granted') S.gyroGranted = true;
    }
  } catch (err) {
    console.warn('[sensor] DeviceOrientation permission error:', err);
  }

  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const state = await DeviceMotionEvent.requestPermission();
      console.log('[sensor] DeviceMotion permission:', state);
      if (state === 'granted') S.gyroGranted = true;
    }
  } catch (err) {
    console.warn('[sensor] DeviceMotion permission error:', err);
  }

  // Register listeners
  window.addEventListener('devicemotion', handleMotion, false);
  window.addEventListener('deviceorientation', handleOrientation, false);

  const diagEl = $('sensor-diag');
  if (diagEl) {
    diagEl.textContent = '📡 SENSORES ACTIVADOS. INCLINA EL CELULAR…';
  }
}

function requestGyroPermission() {
  // Register listeners immediately (works on Android and desktop)
  window.addEventListener('devicemotion', handleMotion, false);
  window.addEventListener('deviceorientation', handleOrientation, false);

  // Diagnostic check after 800ms
  setTimeout(() => {
    if (!S.sensorEventCount || S.sensorEventCount === 0) {
      const diagEl = $('sensor-diag');
      if (!diagEl) return;

      const isHttp = location.protocol === 'http:';
      const isNotLocal = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

      if (isHttp && isNotLocal) {
        // Modern mobile browsers (Chrome Android / Safari iOS) require HTTPS for sensors
        const httpsUrl = `https://${location.hostname}:3443${location.pathname}${location.search}`;
        diagEl.innerHTML = `
          <div style="background:rgba(255,0,127,0.2); border:1px solid var(--pink); border-radius:8px; padding:6px 8px; margin-top:4px;">
            <div style="color:var(--yellow); font-size:0.62rem; font-weight:700;">⚠️ NAVEGADOR BLOQUEA SENSORES EN HTTP</div>
            <a href="${httpsUrl}" style="display:inline-block; margin-top:3px; padding:5px 12px; font-size:0.65rem; background:var(--pink); color:#fff; text-decoration:none; border-radius:6px; font-weight:700;">🔒 ENTRAR EN HTTPS SEGURO</a>
            <button id="btn-force-act" class="btn btn-secondary btn-sm" style="display:inline-block; margin-top:3px; margin-left:4px; padding:4px 8px; font-size:0.62rem;">Tocar para activar</button>
          </div>
        `;
        $('btn-force-act')?.addEventListener('click', activateSensorsByUserGesture);
      } else {
        diagEl.innerHTML = `
          <button id="btn-force-act" class="btn btn-primary btn-sm" style="background:#ff007f; color:#fff; padding:6px 14px; font-size:0.75rem; border-radius:8px; margin-top:4px; cursor:pointer;">
            🔓 ACTIVAR GIROSCOPIO (TOCA AQUÍ)
          </button>
        `;
        $('btn-force-act')?.addEventListener('click', activateSensorsByUserGesture);
      }
    }
  }, 800);

  return Promise.resolve(true);
}

/* ─── Screen lock & WakeLock ─────────────────────────────────────────────── */
async function tryLockLandscape() {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.documentElement.webkitRequestFullscreen) {
      await document.documentElement.webkitRequestFullscreen().catch(() => {});
    }
  } catch {}

  try {
    if (screen.orientation?.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
  } catch {}

  try {
    if ('wakeLock' in navigator) {
      await navigator.wakeLock.request('screen').catch(() => {});
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try { await navigator.wakeLock.request('screen'); } catch {}
        }
      });
    }
  } catch {}
}

function setupTouchButtons() {
  const mapping = [
    { id: 'btn-accel', key: 'accel' },
    { id: 'btn-brake', key: 'brake' },
    { id: 'btn-fire',  key: 'fire' },
    { id: 'btn-power', key: 'power' },
    { id: 'btn-drift', key: 'drift' },
  ];

  const supportsPointer = 'PointerEvent' in window;

  mapping.forEach(({ id, key }) => {
    const btn = $(id);
    if (!btn || btn._wired) return;
    btn._wired = true;

    const press = (e) => {
      if (e.cancelable) e.preventDefault();
      btn.classList.add('pressed');
      S.inputs[key] = true;
      sendInputNow();
    };

    const release = (e) => {
      if (e && e.cancelable) e.preventDefault();
      btn.classList.remove('pressed');
      S.inputs[key] = false;
      sendInputNow();
    };

    if (supportsPointer) {
      btn.addEventListener('pointerdown', (e) => {
        press(e);
      }, { passive: false });
      btn.addEventListener('pointerup', release, { passive: false });
      btn.addEventListener('pointercancel', release, { passive: false });
      btn.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') release(e);
      }, { passive: false });
    } else {
      btn.addEventListener('touchstart', press, { passive: false });
      btn.addEventListener('touchend', release, { passive: false });
      btn.addEventListener('touchcancel', release, { passive: false });
      btn.addEventListener('mousedown', press, { passive: false });
      btn.addEventListener('mouseup', release, { passive: false });
      btn.addEventListener('mouseleave', release, { passive: false });
    }
  });

  window.addEventListener('blur', releaseAllTouchButtons);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllTouchButtons();
  });
}

function releaseAllTouchButtons() {
  ['accel', 'brake', 'fire', 'drift', 'power'].forEach((key) => {
    S.inputs[key] = false;
    const button = $(`btn-${key}`);
    if (button) button.classList.remove('pressed');
  });
  sendInputNow();
}

function sendInputNow() {
  if (!S.socket || !S.socket.connected || !S.seatToken) return;
  S.socket.emit(EV.CONTROLLER_INPUT, {
    seatToken: S.seatToken,
    steerSeq: S.steerSeq,
    inputs: { ...S.inputs, steerSeq: S.steerSeq },
  });
}

function calibrate() {
  const handler = (e) => {
    const g = e.accelerationIncludingGravity;
    let current = 0;
    if (g) {
      if (isUIRotatedPortrait()) {
        const gy = g.y ?? 0;
        const clampedY = Math.max(-9.8, Math.min(9.8, gy));
        current = -Math.asin(clampedY / 9.8) * (180 / Math.PI);
      } else {
        const gx = g.x ?? 0;
        const clampedX = Math.max(-9.8, Math.min(9.8, gx));
        current = Math.asin(clampedX / 9.8) * (180 / Math.PI);
      }
    }
    S.baseline = current;
    S.smoothSteer = 0;
    S.inputs.steer = 0;
    updateSteerVisuals(0, 0);
    toast('⌖ Volante calibrado a posición actual', 'success', 2000);
  };

  window.addEventListener('devicemotion', handler, { once: true });
  S.baseline = 0;
  S.smoothSteer = 0;
  S.inputs.steer = 0;
  updateSteerVisuals(0, 0);
}

function cycleSensitivity() {
  const btn = $('btn-sensitivity');
  if (GYRO.sensitivity === 'normal') {
    GYRO.sensitivity = 'high';
    GYRO.MAX_ANGLE = 15;
    if (btn) btn.textContent = '⚡ Rápido';
    toast('⚡ Sensibilidad: Rápida (15° máx)', 'info', 1500);
  } else if (GYRO.sensitivity === 'high') {
    GYRO.sensitivity = 'soft';
    GYRO.MAX_ANGLE = 34;
    if (btn) btn.textContent = '⚡ Suave';
    toast('⚡ Sensibilidad: Suave (30° máx)', 'info', 1500);
  } else {
    GYRO.sensitivity = 'normal';
    GYRO.MAX_ANGLE = 34;
    if (btn) btn.textContent = '⚡ Normal';
    toast('⚡ Sensibilidad: Normal (30° máx)', 'info', 1500);
  }
}

/* ─── Socket setup ───────────────────────────────────────────────────────── */
function initSocket() {
  S.seatToken = getSeatToken();

  if (typeof io === 'undefined') {
    console.error('Socket.io library not loaded');
    return;
  }

  S.socket = io({ transports: ['websocket', 'polling'] });
  const socket = S.socket;

  socket.on('connect', () => {
    console.log('[ctrl] connected', socket.id);
    const savedName = localStorage.getItem('rr_pilot_name') || 'Piloto';

    // Auto-link immediately with pilot name so the PC recognizes the connected seat right away!
    socket.emit(EV.LINK_SEAT, { seatToken: S.seatToken, name: savedName });

    // Request gyro sensors if supported
    requestGyroPermission();
  });

  socket.on('disconnect', () => {
    console.warn('[ctrl] disconnected');
    if (S.phase === 'controller') {
      $('reconnect-overlay')?.classList.remove('hidden');
    }
  });

  socket.on(EV.SEAT_LINKED, ({ success, name, isHost, carId, weaponId, isReady, roomState }) => {
    if (!success) return;

    S.playerName = name || 'Piloto';
    S.isHost     = isHost;
    if (isReady != null) S.isReady = Boolean(isReady);

    if (carId) {
      const idx = CARS.findIndex(c => c.id === carId);
      if (idx !== -1) S.selectedCarIndex = idx;
    }
    if (weaponId) S.selectedWeaponId = weaponId;

    localStorage.setItem('rr_ctrl_token', S.seatToken);
    localStorage.setItem('rr_pilot_name', S.playerName);
    $('reconnect-overlay')?.classList.add('hidden');
    $('hud-name').textContent = S.playerName;

    if (roomState === 'racing' || roomState === 'countdown') {
      activateController();
    } else {
      showPhase('mobile-selection');
      initMobileSelectionUI();
      updateConfirmationUI();
    }
  });

  socket.on(EV.LOADOUT_UPDATED, ({ carId, weaponId }) => {
    if (carId) {
      const idx = CARS.findIndex(c => c.id === carId);
      if (idx !== -1) S.selectedCarIndex = idx;
    }
    if (weaponId) S.selectedWeaponId = weaponId;
    updateMobileCarDisplay();
    updateMobileWeaponDisplay();
  });

  socket.on('ready_state_changed', ({ isReady }) => {
    S.isReady = Boolean(isReady);
    updateConfirmationUI();
  });

  socket.on(EV.GAME_STARTING, ({ countdownSeconds }) => {
    toast(`🏁 ¡CARRERA EN ${countdownSeconds}s!`, 'success', 4000);
    const resultsOverlay = $('ctrl-results-overlay');
    if (resultsOverlay) resultsOverlay.classList.add('hidden');
    activateController();
  });

  socket.on(EV.CAR_FINISHED, (data) => {
    if (data && data.seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
      toast(`🏁 ¡Terminaste en el puesto P${data.place}! (Modo espectador)`, 'success', 6000);
    }
  });

  function showMobileResults(data) {
    const overlay = $('ctrl-results-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    const res = data.results || [];
    const standings = data.standings || [];
    const myResult = res.find(r => r.seatToken === S.seatToken);
    const myStanding = standings.find(s => s.seatToken === S.seatToken);

    const titleEl = $('ctrl-results-title');
    const subEl = $('ctrl-results-subtitle');
    const isFinished = Boolean(data.championshipFinished);
    const isChamp = Boolean(data.totalRaces && data.totalRaces > 1);

    if (titleEl) {
      titleEl.textContent = isFinished ? '🏆 PODIO FINAL' : '🏁 RESULTADOS';
      titleEl.style.color = isFinished ? 'var(--yellow)' : 'var(--cyan)';
    }
    if (subEl) {
      subEl.textContent = isChamp
        ? `Carrera ${data.raceNumber || 1} de ${data.totalRaces}`
        : 'Carrera finalizada';
    }

    if (myResult || myStanding) {
      const pl = myResult ? myResult.place : (myStanding ? myStanding.place : '—');
      const pts = myResult ? myResult.points : 0;
      const totPts = myStanding ? myStanding.points : pts;
      const plEl = $('ctrl-personal-place');
      const descEl = $('ctrl-personal-desc');
      if (plEl) plEl.textContent = `P${pl}`;
      if (descEl) descEl.textContent = `+${pts} pts esta carrera · Total: ${totPts} pts`;
    }

    // Render standings summary
    const listEl = $('ctrl-standings-list');
    if (listEl) {
      listEl.innerHTML = '';
      const listToRender = isFinished && standings.length > 0 ? standings : (res.length > 0 ? res : standings);
      listToRender.slice(0, 5).forEach((r, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:6px; font-size:0.85rem;';
        const standing = standings.find(s => s.seatToken === r.seatToken) || r;
        const place = r.place || (idx + 1);
        const medal = place === 1 ? '🥇 ' : place === 2 ? '🥈 ' : place === 3 ? '🥉 ' : '';
        const isMe = r.seatToken === S.seatToken;
        row.innerHTML = `
          <span style="font-weight:bold; color:${place === 1 ? '#ffd700' : place === 2 ? '#e0e0e0' : place === 3 ? '#cd7f32' : 'var(--text-muted)'};">${medal}P${place}</span>
          <span style="flex:1; margin:0 8px; color:${isMe ? 'var(--cyan)' : '#ffffff'}; font-weight:${isMe ? 'bold' : 'normal'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.name || 'Piloto'}</span>
          <span style="color:var(--yellow); font-weight:bold;">${standing.points || r.points || 0} pts</span>
        `;
        listEl.appendChild(row);
      });
    }

    // Next track info
    const nextTrackInfo = $('ctrl-next-track-info');
    const nextTrackName = data.nextTrackName;
    if (!isFinished && nextTrackName) {
      if (nextTrackInfo) nextTrackInfo.style.display = 'block';
      const nameEl = $('ctrl-next-track-name');
      const timeEl = $('ctrl-intermission-timer');
      if (nameEl) nameEl.textContent = nextTrackName;
      if (timeEl) timeEl.textContent = `Iniciando en ${data.intermissionSeconds || 12}s…`;
    } else {
      if (nextTrackInfo) nextTrackInfo.style.display = 'none';
    }

    // Host button
    const nextBtn = $('ctrl-btn-next-race');
    if (nextBtn) {
      if (S.isHost && !isFinished && nextTrackName) {
        nextBtn.classList.remove('hidden');
        nextBtn.disabled = false;
        nextBtn.textContent = '⏩ Comenzar siguiente pista';
        nextBtn.onclick = () => {
          const roomCode = S.roomCode || window.location.pathname.split('/')[2];
          const hostToken = localStorage.getItem('rr_host_token') || S.hostToken;
          socket.emit(EV.NEXT_RACE, { roomCode, hostToken });
          nextBtn.disabled = true;
          nextBtn.textContent = 'Iniciando…';
        };
      } else {
        nextBtn.classList.add('hidden');
      }
    }
  }

  socket.on(EV.RACE_FINISHED, (data) => {
    showMobileResults(data);
  });

  socket.on(EV.CHAMPIONSHIP_INTERMISSION, (data) => {
    showMobileResults(data);
    const timerEl = $('ctrl-intermission-timer');
    if (timerEl && data.seconds) {
      timerEl.textContent = `Iniciando en ${data.seconds}s…`;
    }
  });

  socket.on(EV.CHAMPIONSHIP_FINISHED, (data) => {
    showMobileResults(Object.assign({}, data, { championshipFinished: true }));
    toast('🏆 ¡CAMPEONATO FINALIZADO! Podio definitivo.', 'success', 10000);
  });

  socket.on(EV.GAME_STATE, (state) => {
    if (!state || !state.cars) return;
    const myCar = state.cars.find(c => c.st === S.seatToken);
    if (!myCar) return;

    const spdEl = $('hud-speed-val') || $('speed-number');
    const speedFactor = window.SHARED?.PHYSICS?.SPEED_DISPLAY_FACTOR || 0.5;
    if (spdEl) spdEl.textContent = Math.round((myCar.spd || 0) * speedFactor);
    const backgroundSpeed = $('speed-number');
    if (backgroundSpeed && backgroundSpeed !== spdEl) {
      backgroundSpeed.textContent = Math.round((myCar.spd || 0) * speedFactor);
    }

    const posEl = $('hud-pos');
    if (posEl) posEl.textContent = myCar.pos ? `#${myCar.pos}` : '—';

    const lapEl = $('hud-lap');
    if (lapEl) {
      const totalLaps = Number(state.laps) || 3;
      const completedLaps = Number(myCar.lap) || 0;
      const currentLap = Math.min(totalLaps, completedLaps + (myCar.fin ? 0 : 1));
      lapEl.textContent = `${currentLap}/${totalLaps}`;
    }

    const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
    if (ARCADE) {
      const powerEl = $('btn-power-name');
      const powerButton = $('btn-power');
      const iconEl = powerButton?.querySelector('.btn-icon');
      const hudPower = $('hud-power-hud');
      if (myCar.rolling) {
        if (powerEl) powerEl.textContent = '🎲 ABRIENDO…';
        if (iconEl) iconEl.textContent = '❔';
        if (powerButton) powerButton.classList.remove('has-power');
        if (hudPower) hudPower.textContent = '🎲';
      } else if (myCar.power || myCar.item) {
        const it = myCar.power || myCar.item;
        const itNames = { turbo: 'TURBO', disco: 'DISCO', misil: 'MISIL', aceite: 'ACEITE', estrella: 'ESTRELLA', invencibilidad: 'ESTRELLA', tinta: 'TINTA' };
        const itIcons = { turbo: '🔥', disco: '💿', misil: '🚀', aceite: '💧', estrella: '⭐', invencibilidad: '⭐', tinta: '🖌️' };
        if (powerEl) powerEl.textContent = `¡${itNames[it] || it.toUpperCase()}! TOCAR`;
        if (iconEl) iconEl.textContent = itIcons[it] || '⚡';
        if (powerButton) powerButton.classList.add('has-power');
        if (hudPower) hudPower.textContent = (itIcons[it] || '⚡') + ' ' + (itNames[it] || it);
      } else {
        if (powerEl) powerEl.textContent = 'PASAR CAJA';
        if (iconEl) iconEl.textContent = '📦';
        if (powerButton) powerButton.classList.remove('has-power');
        if (hudPower) hudPower.textContent = '—';
      }
    } else {
      const hpEl = $('hud-hp');
      if (hpEl) {
        const hp = Math.max(0, Math.round(myCar.hp || 0));
        hpEl.textContent = `${hp}%`;
        hpEl.style.color = hp < 30 ? 'var(--pink)' : hp < 60 ? 'var(--yellow)' : 'var(--cyan)';
      }

      const ammoEl = $('hud-ammo');
      if (ammoEl) ammoEl.textContent = myCar.ammo != null ? myCar.ammo : '—';

      const powerEl = $('btn-power-name');
      const powerButton = $('btn-power');
      if (powerEl) powerEl.textContent = myCar.power ? `ACTIVAR: ${myCar.power.toUpperCase()}` : 'VACÍO · E';
      if (powerButton) powerButton.classList.toggle('has-power', Boolean(myCar.power));
    }
  });

  socket.on(EV.BOOST_PAD_TRIGGERED, ({ seatToken }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([45, 25, 45]);
      toast('⚡ ¡TURBO PAD! Impulso activado', 'success', 1500);
    }
  });

  // Arcade Item Events with Haptic Feedback
  socket.on(EV.ITEM_BOX_TAKEN, ({ seatToken, item }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([60, 40, 80]);
      const itNames = { turbo: 'Turbo', disco: 'Disco rebotante', misil: 'Misil buscador', aceite: 'Mancha de aceite', estrella: 'Invencibilidad', invencibilidad: 'Invencibilidad', tinta: 'Tinta' };
      toast(`📦 ¡Recibiste ${itNames[item] || item}!`, 'success', 2000);
    }
  });

  socket.on(EV.ITEM_ROLLING, ({ seatToken }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([35]);
    }
  });

  socket.on(EV.ITEM_USED, ({ seatToken, item }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
    }
  });

  socket.on(EV.ITEM_HIT, ({ victim, item }) => {
    if (victim === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      toast(`💥 ¡Te golpearon con ${item}!`, 'error', 2500);
    }
  });

  socket.on(EV.ITEM_BLOCKED, ({ seatToken }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([80, 80]);
      toast('⭐ ¡Bloqueaste el ataque!', 'success', 2000);
    }
  });

  socket.on(EV.PICKUP_COLLECTED, ({ seatToken, type }) => {
    if (seatToken === S.seatToken) {
      if (navigator.vibrate) navigator.vibrate([90]);
      let msg = '⚡ Poder guardado · pulsa PODER / E';
      if (type === 'star') msg += ' ★';
      else if (type === 'banana') msg += ' 🍌';
      else if (type === 'lightning') msg += ' ϟ';
      else if (type === 'rocket') msg += ' ➤';
      else if (type === 'frenzy') msg += ' ✦';
      toast(msg, 'success', 2200);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'e' || event.repeat) return;
    S.inputs.power = true;
    sendInputNow();
  });
  window.addEventListener('keyup', (event) => {
    if (event.key.toLowerCase() !== 'e') return;
    S.inputs.power = false;
    sendInputNow();
  });

  socket.on(EV.PLAYER_KICKED, ({ message }) => {
    showPhase('error');
    $('error-msg').textContent = message || 'Has sido expulsado.';
    localStorage.removeItem('rr_ctrl_token');
  });

  socket.on(EV.ERROR, ({ message }) => {
    toast(message, 'error');
  });
}

/* ─── Activate controller (gameplay HUD) ─────────────────────────────────── */
var _inputInterval = null;
async function activateController() {
  S.controllerActivated = true;
  applyForcedLandscape();
  await tryLockLandscape();
  showPhase('controller');
  setupTouchButtons();

  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  if (ARCADE) {
    const btnFire = $('btn-fire');
    if (btnFire) btnFire.style.display = 'none';
    const ammoCol = $('hud-ammo')?.parentElement;
    if (ammoCol) ammoCol.style.display = 'none';
    const hpCol = $('hud-hp')?.parentElement;
    if (hpCol) hpCol.style.display = 'none';
    const btnPower = $('btn-power');
    if (btnPower) {
      btnPower.style.flex = '2';
      btnPower.style.minHeight = '80px';
    }
  }

  // Hide touch steer zone by default so player controls by tilting!
  const touchZone = $('touch-steer-zone');
  if (touchZone) touchZone.style.display = 'none';

  // Request gyro on activation
  requestGyroPermission();

  if (!_inputInterval) {
    _inputInterval = setInterval(() => {
      if (S.phase === 'controller' && S.socket?.connected) {
        sendInputNow();
      }
    }, 1000 / 60);
  }
}

function applyForcedLandscape() {
  const vp = $('ctrl-viewport');
  if (!vp) return;
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (h > w) {
    // Portrait orientation (or portrait lock on phone):
    // Auto-rotate 90deg so it ALWAYS displays in full screen horizontal mode!
    vp.style.position = 'fixed';
    vp.style.width = `${h}px`;
    vp.style.height = `${w}px`;
    vp.style.top = '50%';
    vp.style.left = '50%';
    vp.style.transform = 'translate(-50%, -50%) rotate(90deg)';
    vp.style.transformOrigin = 'center center';
  } else {
    // Natural landscape orientation:
    vp.style.position = 'fixed';
    vp.style.width = '100vw';
    vp.style.height = '100vh';
    vp.style.top = '0';
    vp.style.left = '0';
    vp.style.transform = 'none';
  }
}

/* ─── Wiring ─────────────────────────────────────────────────────────────── */
function wireButtons() {
  // Always lock and keep full horizontal view on any resize or orientation change
  applyForcedLandscape();
  window.addEventListener('resize', applyForcedLandscape);
  window.addEventListener('orientationchange', applyForcedLandscape);

  // Global user gesture listener to unlock mobile sensors seamlessly
  const tryActivate = () => {
    if (!S.sensorEventCount || S.sensorEventCount === 0) {
      activateSensorsByUserGesture().catch(() => {});
    }
  };
  window.addEventListener('touchend', tryActivate, { passive: true });
  window.addEventListener('click', tryActivate, { passive: true });

  // Name submission
  const submitName = () => {
    const name = ($('input-name')?.value || '').trim();
    if (!name) { toast('Escribe tu nombre'); return; }
    S.playerName = name;
    S.socket.emit(EV.LINK_SEAT, { seatToken: S.seatToken, name });
  };

  $('btn-accept-name')?.addEventListener('click', submitName);
  $('input-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });

  // Permission screen
  $('btn-grant-permission')?.addEventListener('click', async () => {
    await requestGyroPermission();
    showPhase('mobile-selection');
    initMobileSelectionUI();
  });

  $('btn-skip-permission')?.addEventListener('click', () => {
    showPhase('mobile-selection');
    initMobileSelectionUI();
  });

  // Mobile loadout controls
  $('btn-ctrl-car-prev')?.addEventListener('click', () => selectMobileCar(-1));
  $('btn-ctrl-car-next')?.addEventListener('click', () => selectMobileCar(1));
  $('btn-ctrl-weapon-prev')?.addEventListener('click', () => selectMobileWeapon(-1));
  $('btn-ctrl-weapon-next')?.addEventListener('click', () => selectMobileWeapon(1));
  $('btn-ctrl-ready')?.addEventListener('click', toggleMobileReady);
  $('btn-ctrl-unlock')?.addEventListener('click', unlockMobileVehicle);

  // Invert & Calibrate & Sensitivity
  $('btn-calibrate')?.addEventListener('click', calibrate);
  $('btn-invert')?.addEventListener('click', () => {
    S.inverted = !S.inverted;
    toast(S.inverted ? '⇄ Giro invertido' : '⇄ Giro normal');
  });
  $('btn-sensitivity')?.addEventListener('click', cycleSensitivity);

  // Garage / loadout toggle
  $('btn-toggle-garage')?.addEventListener('click', () => {
    showPhase('mobile-selection');
    initMobileSelectionUI();
  });
  $('btn-back-to-ctrl')?.addEventListener('click', () => {
    activateController();
  });
}

/* ─── Init ──────────────────────────────────────────────────────────────── */
function boot() {
  try { wireButtons(); } catch(e) { console.error(e); }
  try { initSocket(); } catch(e) { console.error(e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
