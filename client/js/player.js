/**
 * client/js/player.js
 * Logic for the GUEST PLAYER screen (join.html) - Stage 2
 * Parses room code from URL, joins room, shows QR, auto-transitions on phone link,
 * and handles car/weapon loadout selection, 360 preview, and ready state.
 */
'use strict';

const EV = window.SHARED.EVENTS;
const CARS = window.CONFIG?.CARS || [];
const WEAPONS = window.CONFIG?.WEAPONS || [];
const TRACKS = window.CONFIG?.TRACKS || [];

/* ─── State ─────────────────────────────────────────────────────────────── */
const S = {
  phase:           'loading',  // 'loading' | 'error' | 'qr' | 'linked'
  socket:          null,
  roomCode:        null,
  seatToken:       null,
  inviteUrl:       null,
  ctrlUrl:         null,
  playerName:      null,
  players:         [],
  selectedCarIndex: 0,
  selectedWeaponId: 'vulcan_mg',
  isReady:         false,
  previewAnim:     null,
};

/* ─── DOM helpers ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function showState(name) {
  ['loading','error','qr','linked','race'].forEach(s => {
    const el = $(`state-${s}`);
    if (el) el.classList.toggle('active', s === name);
  });
  S.phase = name;
}

function toast(msg, type = '', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

async function copyText(text, label = 'Enlace') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(`✅ ${label} copiado`, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`✅ ${label} copiado`, 'success');
  }
}

/* ─── Parse room code from URL ──────────────────────────────────────────── */
function getRoomCode() {
  const parts = window.location.pathname.split('/');
  return (parts.pop() || parts.pop() || '').toUpperCase();
}

/* ─── Loadout UI & 360 Animated Preview ─────────────────────────────────── */
function initGuestLoadoutUI() {
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  if (ARCADE) {
    const ws = document.querySelector('.weapons-showcase');
    if (ws) ws.style.display = 'none';
    const lc = document.querySelector('.loadout-container');
    if (lc) { lc.style.gridTemplateColumns = '1fr'; lc.style.maxWidth = '640px'; }
    const hint = $('guest-ready-status-text');
    if (hint) hint.textContent = 'Pulsa cuando hayas definido tu vehículo.';
  }

  // Populate weapon buttons
  const grid = $('guest-weapons-grid');
  if (grid && !ARCADE) {
    grid.innerHTML = WEAPONS.map(w => `
      <button class="weapon-btn ${w.id === S.selectedWeaponId ? 'selected' : ''}" data-weapon-id="${w.id}">
        <span class="weapon-icon">${w.icon}</span>
        <span class="weapon-name">${w.name}</span>
        <span class="weapon-type">${w.stats.difficulty} · ${w.stats.initialAmmo} tiros</span>
      </button>
    `).join('');

    grid.querySelectorAll('.weapon-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectGuestWeapon(btn.dataset.weaponId);
      });
    });
  }

  // Start 360 preview canvas
  const previewCanvas = $('guest-car-preview-canvas');
  if (previewCanvas && window.CAR_RENDERER) {
    if (S.previewAnim) S.previewAnim.stop();
    S.previewAnim = window.CAR_RENDERER.startPreviewAnimation(
      previewCanvas,
      () => CARS[S.selectedCarIndex],
      () => ARCADE ? null : WEAPONS.find(w => w.id === S.selectedWeaponId)
    );
  }

  updateGuestCarDisplay();
  if (!ARCADE) updateGuestWeaponDetails();
}

function selectGuestCar(index) {
  if (CARS.length === 0) return;
  S.selectedCarIndex = (index + CARS.length) % CARS.length;
  updateGuestCarDisplay();
  syncLoadoutToServer();
}

function selectGuestWeapon(weaponId) {
  S.selectedWeaponId = weaponId;
  document.querySelectorAll('#guest-weapons-grid .weapon-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.weaponId === weaponId);
  });
  updateGuestWeaponDetails();
  syncLoadoutToServer();
}

function updateGuestCarDisplay() {
  const car = CARS[S.selectedCarIndex];
  if (!car) return;

  $('guest-car-counter').textContent = `${S.selectedCarIndex + 1} / ${CARS.length}`;
  $('guest-car-name').textContent = car.name;
  $('guest-car-role').textContent = car.role;
  $('guest-car-tagline').textContent = `"${car.tagline}"`;

  const stats = car.stats;
  setGuestStatBar('guest-stat-speed', stats.maxSpeed);
  setGuestStatBar('guest-stat-accel', stats.acceleration);
  setGuestStatBar('guest-stat-handling', stats.handling);
  setGuestStatBar('guest-stat-drift', stats.drift);
  setGuestStatBar('guest-stat-armor', stats.armor);
  setGuestStatBar('guest-stat-weight', stats.weight);
}

function setGuestStatBar(prefix, val) {
  const fill = $(`${prefix}-bar`);
  const num = $(`${prefix}-val`);
  if (fill) fill.style.width = `${Math.min(100, Math.max(10, val))}%`;
  if (num) num.textContent = val;
}

function updateGuestWeaponDetails() {
  const w = WEAPONS.find(item => item.id === S.selectedWeaponId) || WEAPONS[0];
  if (!w) return;

  $('guest-weapon-icon').textContent = w.icon;
  $('guest-weapon-name').textContent = w.name;
  $('guest-weapon-type').textContent = `${w.type.toUpperCase()} · Cadencia: ${w.stats.fireRateHz} Hz`;
  $('guest-weapon-desc').textContent = w.description;
  $('guest-weapon-ammo').textContent = w.stats.initialAmmo;
  $('guest-weapon-dmg').textContent = w.stats.damage;
  $('guest-weapon-diff').textContent = w.stats.difficulty;
}

function syncLoadoutToServer() {
  if (!S.socket || !S.seatToken) return;
  const currentCar = CARS[S.selectedCarIndex];
  if (!currentCar) return;
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  S.socket.emit(EV.SELECT_LOADOUT, {
    seatToken: S.seatToken,
    carId: currentCar.id,
    weaponId: ARCADE ? null : S.selectedWeaponId
  });
}

function toggleGuestReady() {
  S.isReady = !S.isReady;
  const btn = $('guest-btn-ready');
  const hint = $('guest-ready-status-text');
  const ARCADE = Boolean(window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  if (S.isReady) {
    btn.classList.add('is-ready');
    btn.textContent = '✅ ¡LISTO PARA CORRER!';
    hint.textContent = '¡Estás listo! Esperando a que el anfitrión inicie la carrera...';
    toast('¡Marcado como LISTO!', 'success');
  } else {
    btn.classList.remove('is-ready');
    btn.textContent = 'LISTO PARA CORRER';
    hint.textContent = ARCADE ? 'Pulsa cuando hayas definido tu vehículo.' : 'Pulsa cuando hayas definido tu carro y arma.';
  }

  if (S.socket && S.seatToken) {
    S.socket.emit(EV.TOGGLE_READY, {
      seatToken: S.seatToken,
      isReady: S.isReady,
    });
  }
}

/* ─── Enter QR state ─────────────────────────────────────────────────────── */
function enterQR(data) {
  const { seatToken, qrDataUrl, roomCode, inviteUrl, carId, weaponId } = data;

  S.seatToken  = seatToken;
  S.roomCode   = roomCode || S.roomCode;
  S.inviteUrl  = inviteUrl;

  if (carId) {
    const idx = CARS.findIndex(c => c.id === carId);
    if (idx !== -1) S.selectedCarIndex = idx;
  }
  if (weaponId) S.selectedWeaponId = weaponId;

  const origin = window.location.origin;
  S.ctrlUrl    = `${origin}/control/${seatToken}`;

  localStorage.setItem(`rr_seat_${S.roomCode}`, seatToken);

  $('banner-room-code').textContent = S.roomCode;
  if (qrDataUrl) $('player-qr-img').src = qrDataUrl;
  $('ctrl-url-display').textContent = S.ctrlUrl;
  const btnOpenTab = $('btn-open-ctrl-tab');
  if (btnOpenTab) btnOpenTab.href = S.ctrlUrl;

  showState('qr');
}

/* ─── Enter linked state (Stage 2 Loadout) ───────────────────────────────── */
function enterLinked(name) {
  S.playerName = name;
  $('banner-room-code-linked').textContent = S.roomCode;
  $('linked-player-name').textContent = name;

  showState('linked');
  initGuestLoadoutUI();
}

/* ─── Socket setup ──────────────────────────────────────────────────────── */
function initSocket() {
  S.roomCode = getRoomCode();
  if (!S.roomCode) {
    $('error-msg').textContent = 'El código de sala no es válido. Abre el enlace completo que te compartieron.';
    showState('error');
    return;
  }

  if (typeof io === 'undefined') {
    console.error('Socket.io library not loaded');
    toast('Error: no se pudo cargar Socket.IO local', 'error');
    return;
  }

  S.socket = io({ transports: ['websocket', 'polling'] });
  const socket = S.socket;

  socket.on('connect', () => {
    console.log('[socket] guest connected', socket.id);
    const savedToken = localStorage.getItem(`rr_seat_${S.roomCode}`);
    if (savedToken) {
      socket.emit(EV.RECONNECT_SEAT, { seatToken: savedToken });
    } else {
      socket.emit(EV.JOIN_ROOM, { code: S.roomCode });
    }
  });

  socket.on(EV.ROOM_JOINED, (data) => {
    enterQR(data);
    if (data.phoneLinked && data.name) {
      enterLinked(data.name);
    }
  });

  socket.on(EV.SEAT_LINKED, ({ name, seatToken, carId, weaponId }) => {
    if (seatToken === S.seatToken || !S.playerName) {
      if (carId) {
        const idx = CARS.findIndex(c => c.id === carId);
        if (idx !== -1) S.selectedCarIndex = idx;
      }
      if (weaponId) S.selectedWeaponId = weaponId;
      enterLinked(name);
      toast(`🏎️ ¡Bienvenido, ${name}! Elige tu carro`, 'success');
    }
  });

  socket.on(EV.LOADOUT_UPDATED, ({ carId, weaponId }) => {
    if (carId) {
      const idx = CARS.findIndex(c => c.id === carId);
      if (idx !== -1 && idx !== S.selectedCarIndex) {
        S.selectedCarIndex = idx;
        updateGuestCarDisplay();
      }
    }
    if (weaponId && weaponId !== S.selectedWeaponId) {
      S.selectedWeaponId = weaponId;
      updateGuestWeaponDetails();
    }
  });

  socket.on('ready_state_changed', ({ isReady }) => {
    S.isReady = Boolean(isReady);
    const btn = $('guest-btn-ready');
    if (btn) {
      btn.classList.toggle('is-ready', S.isReady);
      btn.textContent = S.isReady ? '✅ ¡LISTO PARA CORRER!' : 'LISTO PARA CORRER';
    }
  });

  socket.on(EV.GAME_STARTING, ({ countdownSeconds, trackId }) => {
    const track = TRACKS.find(t => t.id === trackId) || TRACKS[0];
    toast(`🏁 ¡CARRERA EN ${countdownSeconds}s! Pista: ${track.name}`, 'success', 6000);
    showState('race');
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.init('race-canvas', S.seatToken);
    }
  });

  socket.on(EV.TRACK_DATA, (trackData) => {
    showState('race');
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.init('race-canvas', S.seatToken);
      window.GAME_RENDERER.setTrack(trackData);
    }
  });

  socket.on(EV.GAME_COUNTDOWN, ({ seconds }) => {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setCountdown(seconds);
    }
  });

  socket.on(EV.GAME_STATE, (state) => {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setGameState(state);
    }
  });

  socket.on(EV.PLAYER_ELIMINATED, ({ name }) => {
    toast(`💥 ${name || 'Un piloto'} ha sido eliminado`, 'error', 3000);
  });

  socket.on(EV.PICKUP_COLLECTED, (data) => {
    if (window.GAME_RENDERER && data.x != null && data.y != null) {
      let label = '¡PODER GUARDADO! Pulsa PODER / E';
      let col = '#fee440';
      if (data.type === 'star') { label += ' ★'; col = '#ffd166'; }
      else if (data.type === 'banana') { label += ' 🍌'; col = '#f4d35e'; }
      else if (data.type === 'lightning') { label += ' ϟ'; col = '#8ecae6'; }
      else if (data.type === 'rocket') { label += ' ➤'; col = '#ff7b00'; }
      else if (data.type === 'frenzy') { label += ' ✦'; col = '#ff6b35'; }
      window.GAME_RENDERER.addFloatingText(label, data.x, data.y, col);
      if (window.GAME_RENDERER.triggerPowerEffect) {
        window.GAME_RENDERER.triggerPowerEffect({ type: 'pickup', x: data.x, y: data.y });
      }
    }
  });

  socket.on(EV.POWERUP_EFFECT, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.triggerPowerEffect) {
      window.GAME_RENDERER.triggerPowerEffect(data);
    }
  });

  // Arcade Item Events
  socket.on(EV.ITEM_BOX_TAKEN, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_BOX_TAKEN, data);
    }
  });
  socket.on(EV.ITEM_ROLLING, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_ROLLING, data);
    }
  });
  socket.on(EV.ITEM_USED, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_USED, data);
    }
  });
  socket.on(EV.ITEM_HIT, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_HIT, data);
    }
  });
  socket.on(EV.ITEM_BLOCKED, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_BLOCKED, data);
    }
  });

  socket.on(EV.RACE_FINISHED, (data) => {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setResults(data);
    }
    toast(data.championshipFinished ? '🏆 ¡Campeonato finalizado!' : '🏆 ¡Carrera finalizada!', 'success', 8000);
  });

  socket.on(EV.CHAMPIONSHIP_INTERMISSION, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setIntermission) {
      window.GAME_RENDERER.setIntermission(data);
    }
  });

  socket.on(EV.CHAMPIONSHIP_FINISHED, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setResults) {
      window.GAME_RENDERER.setResults({ ...data, championshipFinished: true });
    }
    toast('🏆 ¡CAMPEONATO FINALIZADO! Podio definitivo.', 'success', 10000);
  });

  socket.on(EV.CAR_FINISHED, (data) => {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setArrival) {
      window.GAME_RENDERER.setArrival(data);
    }
    if (data && data.name) {
      toast(`🏁 ${data.name} llegó en P${data.place}`, 'success', 3500);
    }
  });

  socket.on(EV.PLAYER_KICKED, ({ message }) => {
    $('error-msg').textContent = message || 'Has sido expulsado de la sala.';
    showState('error');
    localStorage.removeItem(`rr_seat_${S.roomCode}`);
  });

  socket.on(EV.ROOM_NOT_FOUND, ({ message }) => {
    $('error-msg').textContent = message;
    showState('error');
  });

  socket.on(EV.ROOM_FULL, ({ message }) => {
    $('error-msg').textContent = message;
    showState('error');
  });

  socket.on(EV.ERROR, ({ message }) => {
    toast(message, 'error');
  });
}

/* ─── Button wiring ──────────────────────────────────────────────────────── */
function wireButtons() {
  $('btn-copy-ctrl')?.addEventListener('click', () => copyText(S.ctrlUrl, 'Enlace de control'));

  // Car Navigation buttons
  $('guest-btn-car-prev')?.addEventListener('click', () => selectGuestCar(S.selectedCarIndex - 1));
  $('guest-btn-car-next')?.addEventListener('click', () => selectGuestCar(S.selectedCarIndex + 1));

  // Ready button
  $('guest-btn-ready')?.addEventListener('click', toggleGuestReady);
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
