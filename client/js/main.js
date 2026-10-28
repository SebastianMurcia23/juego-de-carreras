(function() {
/**
 * client/js/main.js  v4.0
 * HOST screen logic - Road Rumble
 */

/* ------------------------------------------------------------------ state */
var S = {
  phase:            'landing',
  socket:           null,
  roomCode:         null,
  hostToken:        null,
  seatToken:        null,
  inviteUrl:        null,
  ctrlUrl:          null,
  players:          [],
  phoneLinked:      false,
  selectedCarIndex: 0,
  selectedWeaponId: 'vulcan_mg',
  isReady:          false,
  previewAnim:      null,
  settings: {
    mode:             'championship',
    trackId:          'track_01_neon_city',
    laps:             3,
    ammoMultiplier:   1.0,
    itemDistribution: 'positional',
  }
};

/* Safe access to shared constants */
var EV = (window.SHARED && window.SHARED.EVENTS) ? window.SHARED.EVENTS : {
  CREATE_ROOM:         'create_room',
  ROOM_CREATED:        'room_created',
  JOIN_ROOM:           'join_room',
  ROOM_JOINED:         'room_joined',
  LINK_SEAT:           'link_seat',
  SEAT_LINKED:         'seat_linked',
  RECONNECT_HOST:      'reconnect_host',
  RECONNECT_SEAT:      'reconnect_seat',
  RECONNECT_MOBILE:    'reconnect_mobile',
  PLAYERS_UPDATED:     'players_updated',
  HOST_TRANSFERRED:    'host_transferred',
  PLAYER_DISCONNECTED: 'player_disconnected',
  SELECT_LOADOUT:      'select_loadout',
  LOADOUT_UPDATED:     'loadout_updated',
  TOGGLE_READY:        'toggle_ready',
  UPDATE_SETTINGS:     'update_settings',
  SETTINGS_UPDATED:    'settings_updated',
  KICK_PLAYER:         'kick_player',
  START_GAME:          'start_game',
  GAME_STARTING:       'game_starting',
  GAME_COUNTDOWN:      'game_countdown',
  GAME_STATE:          'game_state',
  RACE_FINISHED:       'race_finished',
  TRACK_DATA:          'track_data',
  PLAYER_ELIMINATED:   'player_eliminated',
  ERROR:               'error'
};

/* Safe config access */
var CARS    = (window.CONFIG && window.CONFIG.CARS)    ? window.CONFIG.CARS    : [];
var WEAPONS = (window.CONFIG && window.CONFIG.WEAPONS) ? window.CONFIG.WEAPONS : [];
var TRACKS  = (window.CONFIG && window.CONFIG.TRACKS)  ? window.CONFIG.TRACKS  : [];

/* Expose globally */
window.S  = S;
window.EV = EV;

/* ------------------------------------------------------------------ utils */
function $(id) { return document.getElementById(id); }

function showState(name) {
  console.log('[showState] -> ' + name);
  var ids = ['state-landing', 'state-creating', 'state-lobby', 'state-race'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (!el) { console.warn('[showState] Element not found:', ids[i]); continue; }
    if (ids[i] === 'state-' + name) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }
  S.phase = name;
}

function toast(msg, type, duration) {
  duration = duration || 3500;
  var el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  var tc = $('toast-container') || document.body;
  tc.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, duration);
}

function copyText(text, label) {
  if (!text) return;
  label = label || 'Enlace';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      toast(label + ' copiado', 'success');
    }).catch(function() { fallbackCopy(text, label); });
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  var ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(label + ' copiado', 'success'); } catch(e) {}
  document.body.removeChild(ta);
}

/* ----------------------------------------------------------- socket setup */
function initSocket() {
  if (typeof io === 'undefined') {
    console.error('[initSocket] Socket.IO not loaded!');
    toast('Error de conexion con el servidor', 'error');
    return;
  }
  if (S.socket) {
    console.log('[initSocket] Socket already exists, id=' + S.socket.id);
    return;
  }

  console.log('[initSocket] Creating socket...');
  S.socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  S.socket.on('connect', function() {
    console.log('[socket] CONNECTED id=' + S.socket.id + ' phase=' + S.phase);
    var savedHostToken = localStorage.getItem('rr_host_token');
    var savedRoomCode = localStorage.getItem('rr_room_code');
    if (savedHostToken && savedRoomCode && S.phase === 'landing') {
      showState('creating');
      S.socket.emit(EV.RECONNECT_HOST, {
        roomCode: savedRoomCode,
        hostToken: savedHostToken
      });
    }
  });

  S.socket.on('disconnect', function(reason) {
    console.warn('[socket] disconnected:', reason);
  });

  S.socket.on('connect_error', function(err) {
    console.error('[socket] connect_error:', err && err.message);
  });

  S.socket.on(EV.ROOM_CREATED, function(data) {
    console.log('[socket] room_created received:', JSON.stringify(data).substring(0, 100));
    enterLobby(data);
  });

  S.socket.on(EV.SEAT_LINKED, function(data) {
    var name = data.name, seatToken = data.seatToken, isHost = data.isHost;
    var carId = data.carId, weaponId = data.weaponId;
    if (seatToken === S.seatToken || isHost) {
      showLinkedState(name);
      if (carId) {
        var idx = findCarIndex(carId);
        if (idx !== -1) S.selectedCarIndex = idx;
      }
      if (weaponId) S.selectedWeaponId = weaponId;
      updateCarDisplay();
      updateWeaponDetails();
    } else {
      toast('\uD83C\uDFCE\uFE0F ' + name + ' vinculo su celular', 'success');
    }
  });

  S.socket.on(EV.PLAYERS_UPDATED, function(data) {
    renderPlayerList(data.players || []);
  });

  S.socket.on(EV.SETTINGS_UPDATED, function(data) {
    if (data.settings) {
      S.settings = merge(S.settings, data.settings);
      syncAdminFormValues();
    }
    toast('Configuracion actualizada', 'success');
  });

  S.socket.on(EV.HOST_TRANSFERRED, function(data) {
    S.hostToken = data.newHostToken;
    toast('\uD83D\uDC51 ' + (data.message || 'Eres el nuevo anfitrion'), 'success', 5000);
  });

  S.socket.on(EV.PLAYER_DISCONNECTED, function(data) {
    if (data.role === 'mobile' && data.name) {
      toast('\uD83D\uDCF5 ' + data.name + ' desconecto su celular');
    }
  });

  S.socket.on(EV.GAME_STARTING, function(data) {
    var cds = data.countdownSeconds || 3;
    var track = findTrack(data.trackId);
    toast('🏁 ¡CARRERA EN ' + cds + 's! Pista: ' + (track ? track.name : ''), 'success', 6000);
    showState('race');
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.init('race-canvas', S.seatToken);
    }
  });

  S.socket.on(EV.TRACK_DATA, function(trackData) {
    showState('race');
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.init('race-canvas', S.seatToken);
      window.GAME_RENDERER.setTrack(trackData);
    }
  });

  S.socket.on(EV.GAME_COUNTDOWN, function(data) {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setCountdown(data.seconds);
    }
  });

  S.socket.on(EV.GAME_STATE, function(state) {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setGameState(state);
    }
  });

  S.socket.on(EV.PLAYER_ELIMINATED, function(data) {
    toast('💥 ' + (data.name || 'Un piloto') + ' ha sido eliminado', 'error', 3000);
  });

  S.socket.on(EV.PICKUP_COLLECTED, function(data) {
    if (window.GAME_RENDERER && data.x != null && data.y != null) {
      var label = '¡PODER GUARDADO! Pulsa PODER / E';
      var col = '#fee440';
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

  S.socket.on(EV.POWERUP_EFFECT, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.triggerPowerEffect) {
      window.GAME_RENDERER.triggerPowerEffect(data);
    }
  });

  S.socket.on(EV.RACE_FINISHED, function(data) {
    if (window.GAME_RENDERER) {
      window.GAME_RENDERER.setResults(data);
    }
  });

  S.socket.on(EV.CHAMPIONSHIP_INTERMISSION, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setIntermission) {
      window.GAME_RENDERER.setIntermission(data);
    }
  });

  S.socket.on(EV.CHAMPIONSHIP_FINISHED, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setResults) {
      window.GAME_RENDERER.setResults(Object.assign({}, data, {
        championshipFinished: true,
      }));
    }
    toast('🏆 ¡CAMPEONATO FINALIZADO! Podio definitivo.', 'success', 10000);
  });

  S.socket.on(EV.CAR_FINISHED, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.setArrival) {
      window.GAME_RENDERER.setArrival(data);
    }
    if (data && data.name) {
      toast('🏁 ' + data.name + ' llegó en P' + data.place, 'success', 3500);
    }
  });

  // Arcade Item Events
  S.socket.on(EV.ITEM_BOX_TAKEN, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_BOX_TAKEN, data);
    }
  });
  S.socket.on(EV.ITEM_ROLLING, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_ROLLING, data);
    }
  });
  S.socket.on(EV.ITEM_USED, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_USED, data);
    }
  });
  S.socket.on(EV.ITEM_HIT, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_HIT, data);
    }
  });
  S.socket.on(EV.ITEM_BLOCKED, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.ITEM_BLOCKED, data);
    }
  });

  S.socket.on(EV.WRONG_WAY_WARNING, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.WRONG_WAY_WARNING, data);
    }
  });
  S.socket.on(EV.WRONG_WAY_CLEARED, function(data) {
    if (window.GAME_RENDERER && window.GAME_RENDERER.handleItemEvent) {
      window.GAME_RENDERER.handleItemEvent(EV.WRONG_WAY_CLEARED, data);
    }
  });

  S.socket.on(EV.LOADOUT_UPDATED, function(data) {
    if (data.carId) {
      var idx = findCarIndex(data.carId);
      if (idx !== -1 && idx !== S.selectedCarIndex) {
        S.selectedCarIndex = idx;
        updateCarDisplay();
      }
    }
    if (data.weaponId && data.weaponId !== S.selectedWeaponId) {
      S.selectedWeaponId = data.weaponId;
      updateWeaponDetails();
    }
  });

  S.socket.on('ready_state_changed', function(data) {
    S.isReady = Boolean(data.isReady);
    var btn = $('btn-toggle-ready');
    if (btn) {
      if (S.isReady) { btn.classList.add('is-ready'); btn.textContent = 'LISTO PARA CORRER'; }
      else { btn.classList.remove('is-ready'); btn.textContent = 'LISTO PARA CORRER'; }
    }
  });

  S.socket.on(EV.ERROR, function(data) {
    if (_createTimeout) { clearTimeout(_createTimeout); _createTimeout = null; }
    console.error('[socket] server error:', data ? data.message : 'unknown');
    toast((data && data.message) || 'Error del servidor', 'error');
    if (S.phase === 'creating') {
      showState('landing');
      var b = $('btn-create');
      if (b) {
        b.disabled = false;
        b.innerHTML = '🏁 &nbsp;Crear sala como administrador';
      }
    }
  });

  console.log('[initSocket] Socket object created, waiting for connection...');
}

/* ------------------------------------------------- create room (THE FIX) */
var _createTimeout = null;

function doCreateRoom() {
  console.log('[doCreateRoom] called. socket exists:', !!S.socket, 'connected:', S.socket && S.socket.connected);
  if (!S.socket) {
    initSocket();
  }
  if (S.socket && S.socket.connected) {
    console.log('[doCreateRoom] EMITTING create_room NOW');
    S.socket.emit(EV.CREATE_ROOM);
  } else if (S.socket) {
    console.log('[doCreateRoom] Socket not connected yet, connecting...');
    S.socket.connect();
    S.socket.once('connect', function() {
      console.log('[doCreateRoom] Socket connected now, EMITTING create_room');
      S.socket.emit(EV.CREATE_ROOM);
    });
  }
}

window.triggerCreateRoom = window.handleCreateClick = function(e) {
  if (e && e.preventDefault) e.preventDefault();
  console.log('[handleCreateClick] FIRED. phase=' + S.phase + ' socket=' + (S.socket ? S.socket.id || 'init' : 'null'));

  if (S.phase === 'lobby') {
    console.log('[handleCreateClick] Already in lobby, skipping');
    return;
  }

  var btn = $('btn-create');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ &nbsp;Creando sala…';
  }

  showState('creating');

  if (_createTimeout) clearTimeout(_createTimeout);
  _createTimeout = setTimeout(function() {
    if (S.phase === 'creating') {
      console.warn('[triggerCreateRoom] Timeout after 4.5s, resetting to landing');
      showState('landing');
      var b = $('btn-create');
      if (b) {
        b.disabled = false;
        b.innerHTML = '🏁 &nbsp;Crear sala como administrador';
      }
      toast('Tiempo de espera agotado. Reintentando conexión...', 'error');
      if (S.socket) S.socket.connect();
    }
  }, 4500);

  if (!S.socket) {
    initSocket();
  }

  doCreateRoom();
};

/* ----------------------------------------------------------- enter lobby */
window.enterLobby = function(data) {
  console.log('[enterLobby] Entering lobby with roomCode=' + data.roomCode);
  if (_createTimeout) { clearTimeout(_createTimeout); _createTimeout = null; }
  var btnCreate = $('btn-create');
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.innerHTML = '🏁 &nbsp;Crear sala como administrador';
  }

  try {
    S.roomCode   = data.roomCode;
    S.hostToken  = data.hostToken;
    S.seatToken  = data.seatToken;
    S.inviteUrl  = data.inviteUrl;
    S.phoneLinked = Boolean(data.phoneLinked);
    if (S.hostToken) localStorage.setItem('rr_host_token', S.hostToken);
    if (S.roomCode) localStorage.setItem('rr_room_code', S.roomCode);

    if (data.settings) S.settings = merge(S.settings, data.settings);
    if (data.carId) {
      var idx = findCarIndex(data.carId);
      if (idx !== -1) S.selectedCarIndex = idx;
    }
    if (data.weaponId) S.selectedWeaponId = data.weaponId;

    var origin = window.location.origin;
    S.ctrlUrl = data.controlUrl || (origin + '/control/' + data.seatToken);

    setText('banner-code',        data.roomCode);
    setText('admin-code',         data.roomCode);
    setText('admin-invite-url',   data.inviteUrl  || '');
    setText('invite-url-display', data.inviteUrl  || '');
    setText('host-ctrl-url',      S.ctrlUrl);

    var btnOpenTab = $('btn-open-ctrl-tab');
    if (btnOpenTab) {
      btnOpenTab.href = S.ctrlUrl;
    }

    var btnQuickLink = $('btn-quick-link-host');
    if (btnQuickLink) {
      btnQuickLink.disabled = false;
      btnQuickLink.textContent = '⚡ Vincular directamente como Anfitrión';
      btnQuickLink.onclick = function() {
        if (!S.socket || !S.seatToken) return;
        btnQuickLink.disabled = true;
        btnQuickLink.textContent = 'Vinculando piloto...';
        S.socket.emit(EV.LINK_SEAT, { seatToken: S.seatToken, name: 'Anfitrión' });
      };
    }

    var qrImg = $('host-qr-img');
    if (qrImg && data.qrDataUrl) qrImg.src = data.qrDataUrl;

    try { initLoadoutUI(); } catch(e) { console.warn('[enterLobby] loadout ui error:', e); }
    syncAdminFormValues();

    if (data.phoneLinked) {
      showLinkedState(data.playerName);
    } else {
      showEl('host-qr-section');
      hideEl('host-loadout-section');
    }

    if (data.players) {
      try { renderPlayerList(data.players); } catch(e) { console.warn('[enterLobby] player list error:', e); }
    }
  } catch(err) {
    console.error('[enterLobby] error:', err);
  }
  showState('lobby');
  console.log('[enterLobby] Done. State is now lobby.');
};

function showLinkedState(name) {
  S.phoneLinked = true;
  hideEl('host-qr-section');
  showEl('host-loadout-section');
  try { initLoadoutUI(); } catch(e) {}
  if (name) toast('\uD83C\uDFCE\uFE0F ¡Conectado como piloto: "' + name + '"!', 'success');
}

/* ---------------------------------------------------------- helpers */
function setText(id, val) {
  var el = $(id);
  if (el) el.textContent = val || '';
}
function showEl(id) {
  var el = $(id);
  if (el) el.classList.remove('hidden');
}
function hideEl(id) {
  var el = $(id);
  if (el) el.classList.add('hidden');
}
function merge(base, extra) {
  var out = {};
  for (var k in base) { if (base.hasOwnProperty(k)) out[k] = base[k]; }
  for (var k in extra) { if (extra.hasOwnProperty(k)) out[k] = extra[k]; }
  return out;
}
function findCarIndex(carId) {
  for (var i = 0; i < CARS.length; i++) {
    if (CARS[i].id === carId) return i;
  }
  return -1;
}
function findTrack(trackId) {
  for (var i = 0; i < TRACKS.length; i++) {
    if (TRACKS[i].id === trackId) return TRACKS[i];
  }
  return TRACKS[0] || null;
}

/* -------------------------------------------------------- logo canvas */
function drawLogo() {
  var canvas = $('logo-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.shadowColor = '#00f5d4'; ctx.shadowBlur = 20;
  ctx.strokeStyle = '#00f5d4'; ctx.lineWidth = 2.5;
  ctx.fillStyle = 'rgba(0,245,212,0.08)';
  ctx.beginPath();
  ctx.moveTo(20,90); ctx.lineTo(40,90); ctx.lineTo(60,55); ctx.lineTo(120,40);
  ctx.lineTo(200,40); ctx.lineTo(240,55); ctx.lineTo(285,60); ctx.lineTo(300,90);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(100,56); ctx.lineTo(115,44); ctx.lineTo(195,44); ctx.lineTo(210,56);
  ctx.closePath(); ctx.strokeStyle = '#f72585'; ctx.stroke();
  ctx.fillStyle = '#0a0d14'; ctx.shadowBlur = 10;
  [75, 245].forEach(function(x) {
    ctx.beginPath(); ctx.arc(x, 90, 18, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  });
}

/* -------------------------------------------------------- loadout UI */
function initLoadoutUI() {
  var ARCADE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  if (ARCADE) {
    var ws = document.querySelector('.weapons-showcase');
    if (ws) ws.style.display = 'none';
    var lc = document.querySelector('.loadout-container');
    if (lc) { lc.style.gridTemplateColumns = '1fr'; lc.style.maxWidth = '640px'; }
    var hint = $('ready-status-text');
    if (hint) hint.textContent = 'Pulsa cuando hayas definido tu vehículo.';
  }

  var grid = $('weapons-grid');
  if (grid && WEAPONS.length && !ARCADE) {
    var html = '';
    for (var i = 0; i < WEAPONS.length; i++) {
      var w = WEAPONS[i];
      html += '<button class="weapon-btn' + (w.id === S.selectedWeaponId ? ' selected' : '') +
              '" data-weapon-id="' + w.id + '">' +
              '<span class="weapon-icon">' + w.icon + '</span>' +
              '<span class="weapon-name">' + w.name + '</span>' +
              '<span class="weapon-type">' + w.stats.difficulty + ' · ' + w.stats.initialAmmo + ' tiros</span>' +
              '</button>';
    }
    grid.innerHTML = html;
    var btns = grid.querySelectorAll('.weapon-btn');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', (function(btn) {
        return function() { selectWeapon(btn.getAttribute('data-weapon-id')); };
      })(btns[j]));
    }
  }

  var trackSelect = $('admin-select-track');
  if (trackSelect && trackSelect.options.length === 0 && TRACKS.length) {
    var tHtml = '';
    for (var t = 0; t < TRACKS.length; t++) {
      tHtml += '<option value="' + TRACKS[t].id + '">' + (t+1) + '. ' + TRACKS[t].name + '</option>';
    }
    trackSelect.innerHTML = tHtml;
  }

  var previewCanvas = $('car-preview-canvas');
  if (previewCanvas && window.CAR_RENDERER) {
    if (S.previewAnim) S.previewAnim.stop();
    S.previewAnim = window.CAR_RENDERER.startPreviewAnimation(
      previewCanvas,
      function() { return CARS[S.selectedCarIndex]; },
      function() {
        if (ARCADE) return null;
        for (var i = 0; i < WEAPONS.length; i++) {
          if (WEAPONS[i].id === S.selectedWeaponId) return WEAPONS[i];
        }
        return WEAPONS[0];
      }
    );
  }
  updateCarDisplay();
  if (!ARCADE) updateWeaponDetails();
}

function selectCar(index) {
  if (S.isReady) {
    toast('Vehículo confirmado. Pulsa "Cambiar vehículo" para desbloquear.', 'info');
    return;
  }
  if (!CARS.length) return;
  S.selectedCarIndex = ((index % CARS.length) + CARS.length) % CARS.length;
  updateCarDisplay();
  syncLoadoutToServer();
}

function selectWeapon(weaponId) {
  S.selectedWeaponId = weaponId;
  var btns = document.querySelectorAll('.weapon-btn');
  for (var i = 0; i < btns.length; i++) {
    var wid = btns[i].getAttribute('data-weapon-id');
    if (wid === weaponId) { btns[i].classList.add('selected'); }
    else { btns[i].classList.remove('selected'); }
  }
  updateWeaponDetails();
  syncLoadoutToServer();
}

function updateCarDisplay() {
  var car = CARS[S.selectedCarIndex];
  if (!car) return;
  setText('car-counter', (S.selectedCarIndex + 1) + ' / ' + CARS.length);
  setText('car-name-display', car.name);
  setText('car-role-display', car.role);
  setText('car-tagline-display', '"' + car.tagline + '"');
  setStatBar('stat-speed',    car.stats.maxSpeed);
  setStatBar('stat-accel',    car.stats.acceleration);
  setStatBar('stat-handling', car.stats.handling);
  setStatBar('stat-drift',    car.stats.drift);
  setStatBar('stat-armor',    car.stats.armor);
  setStatBar('stat-weight',   car.stats.weight);
}

function setStatBar(prefix, val) {
  var fill = $(prefix + '-bar');
  var num  = $(prefix + '-val');
  if (fill) fill.style.width = Math.min(100, Math.max(10, val)) + '%';
  if (num)  num.textContent  = val;
}

function updateWeaponDetails() {
  var w = null;
  for (var i = 0; i < WEAPONS.length; i++) {
    if (WEAPONS[i].id === S.selectedWeaponId) { w = WEAPONS[i]; break; }
  }
  if (!w && WEAPONS.length) w = WEAPONS[0];
  if (!w) return;
  setText('weapon-detail-icon',  w.icon);
  setText('weapon-detail-name',  w.name);
  setText('weapon-detail-type',  w.type.toUpperCase() + ' - Cadencia: ' + w.stats.fireRateHz + ' Hz');
  setText('weapon-detail-desc',  w.description);
  setText('weapon-detail-ammo',  w.stats.initialAmmo);
  setText('weapon-detail-dmg',   w.stats.damage);
  setText('weapon-detail-diff',  w.stats.difficulty);
}

function syncLoadoutToServer() {
  if (!S.socket || !S.seatToken) return;
  var car = CARS[S.selectedCarIndex];
  if (!car) return;
  var ARCADE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  S.socket.emit(EV.SELECT_LOADOUT, {
    seatToken: S.seatToken,
    carId: car.id,
    weaponId: ARCADE ? null : S.selectedWeaponId
  });
}

function toggleReady() {
  S.isReady = !S.isReady;
  var btn  = $('btn-toggle-ready');
  var hint = $('ready-status-text');
  var prevBtn = $('btn-car-prev');
  var nextBtn = $('btn-car-next');
  var ARCADE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  if (S.isReady) {
    if (btn) {
      btn.classList.add('is-ready');
      btn.textContent = '✓ Vehículo Confirmado (Cambiar)';
      btn.style.background = '#00f5d4';
      btn.style.color = '#000';
    }
    if (prevBtn) { prevBtn.disabled = true; prevBtn.style.opacity = '0.35'; prevBtn.style.pointerEvents = 'none'; }
    if (nextBtn) { nextBtn.disabled = true; nextBtn.style.opacity = '0.35'; nextBtn.style.pointerEvents = 'none'; }
    if (hint) hint.textContent = '¡Vehículo confirmado! Esperando a los demás pilotos...';
    toast('✓ Vehículo confirmado para la carrera', 'success', 2000);
  } else {
    if (btn) {
      btn.classList.remove('is-ready');
      btn.textContent = '🏎️ Confirmar Vehículo';
      btn.style.background = '';
      btn.style.color = '';
    }
    if (prevBtn) { prevBtn.disabled = false; prevBtn.style.opacity = ''; prevBtn.style.pointerEvents = ''; }
    if (nextBtn) { nextBtn.disabled = false; nextBtn.style.opacity = ''; nextBtn.style.pointerEvents = ''; }
    if (hint) hint.textContent = ARCADE ? 'Pulsa para confirmar tu vehículo.' : 'Pulsa cuando hayas definido tu carro y arma.';
    toast('Vehículo desbloqueado para cambios', 'info', 2000);
  }

  if (S.socket && S.seatToken) {
    S.socket.emit(EV.TOGGLE_READY, { seatToken: S.seatToken, isReady: S.isReady });
  }
}

/* -------------------------------------------------------- player list */
function renderPlayerList(players) {
  S.players = players || [];
  var count = S.players.length;
  var confirmedCount = S.players.filter(function(p) { return p.isReady; }).length;
  var ARCADE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
  setText('player-count-badge', confirmedCount + ' / ' + count + ' confirmados');
  setText('admin-player-count', confirmedCount + ' / ' + count + ' confirmados');

  var btnStart = $('btn-start-game');
  if (btnStart) {
    var allReady = count > 0 && S.players.every(function(p) { return p.isReady || !p.name; });
    if (allReady) {
      btnStart.innerHTML = '🏁 ¡INICIAR CARRERA! (Todos listos)';
      btnStart.style.background = '#00f5d4';
      btnStart.style.color = '#000';
      btnStart.style.boxShadow = '0 0 20px rgba(0, 245, 212, 0.4)';
    } else {
      btnStart.innerHTML = '⚠️ Iniciar de todos modos (' + confirmedCount + '/' + count + ' listos)';
      btnStart.style.background = '';
      btnStart.style.color = '';
      btnStart.style.boxShadow = '';
    }
  }

  var miniList = $('mini-player-list');
  if (miniList) {
    var html = '';
    for (var i = 0; i < S.players.length; i++) {
      var p = S.players[i];
      var statusText = '';
      if (!p.mobileConnected && p.name) statusText = '<span style="color:var(--pink);font-size:0.65rem;">Desconectado...</span>';
      else if (p.isReady) statusText = '<span class="badge-ready" style="font-size:0.62rem;">✓ Confirmado</span>';
      else if (p.name) statusText = '<span class="badge badge-linked" style="font-size:0.62rem;">Eligiendo</span>';
      else statusText = '<span class="badge badge-qr" style="font-size:0.62rem;">Esperando QR</span>';
      html += '<div class="player-row">' +
        '<span class="player-num">#' + (i+1) + '</span>' +
        '<span class="player-name">' + (p.name || '<em style="color:var(--text-dim)">Puesto libre</em>') +
        (p.isHost ? ' <span class="badge badge-host" style="font-size:0.6rem;">HOST</span>' : '') + '</span>' +
        '<div class="flex-row items-center gap-8">' +
        '<span class="dot ' + (p.mobileConnected ? 'dot-on' : (p.name ? 'dot-warn' : 'dot-off')) + '"></span>' +
        statusText +
        '</div></div>';
    }
    miniList.innerHTML = html;
  }

  var adminList = $('admin-player-list');
  if (adminList) {
    var aHtml = '';
    for (var ai = 0; ai < S.players.length; ai++) {
      var ap = S.players[ai];
      var car    = findCar(ap.carId) || (CARS[0] || null);
      var weapon = findWeapon(ap.weaponId) || (WEAPONS[0] || null);
      var weaponSnippet = (!ARCADE && weapon) ? ('<span>·</span><span>' + weapon.icon + ' ' + weapon.name + '</span>') : '';
      var disconnectedSnippet = (!ap.mobileConnected && ap.name) ? '<span style="color:var(--pink);font-size:0.65rem;">Desconectado (volviendo...)</span>' : '';
      aHtml += '<div class="player-row" style="padding:10px 14px;' + (!ap.mobileConnected && ap.name ? 'opacity:0.6;' : '') + '">' +
        '<div class="player-thumb-wrap"><canvas class="player-thumb-canvas" id="thumb-admin-' + ai + '" width="42" height="26"></canvas></div>' +
        '<div class="flex-col" style="flex:1;min-width:0;">' +
        '<div class="player-name" style="font-size:0.85rem;font-weight:700;">' +
        (ap.name || '<em style="color:var(--text-dim)">Sin nombre</em>') +
        (ap.isHost ? ' <span class="badge badge-host" style="font-size:0.55rem;">HOST</span>' : '') + '</div>' +
        '<div style="font-size:0.68rem;color:var(--text-muted);display:flex;gap:8px;">' +
        '<span style="color:' + (car && car.color ? car.color : '#00f5d4') + ';font-weight:600;">' + (car ? car.name : 'Carro') + '</span>' +
        weaponSnippet + '</div>' +
        (disconnectedSnippet ? '<div style="margin-top:2px;">' + disconnectedSnippet + '</div>' : '') +
        '</div>' +
        '<div class="flex-row items-center gap-8">' +
        (ap.isReady ? '<span class="badge-ready">✓ Confirmado</span>' : '<span class="badge-selecting">Eligiendo</span>') +
        (!ap.isHost ? '<button class="btn-kick" data-kick-token="' + ap.seatToken + '" title="Expulsar">X</button>' : '') +
        '</div></div>';
    }
    adminList.innerHTML = aHtml;

    for (var ti = 0; ti < S.players.length; ti++) {
      var tc = document.getElementById('thumb-admin-' + ti);
      if (tc && window.CAR_RENDERER) {
        var tcar = findCar(S.players[ti].carId) || (CARS[0] || null);
        var tweapon = findWeapon(S.players[ti].weaponId) || (WEAPONS[0] || null);
        window.CAR_RENDERER.drawCar(tc.getContext('2d'), 21, 13, tcar, ARCADE ? null : tweapon, 0, 0.45);
      }
    }

    var kickBtns = adminList.querySelectorAll('.btn-kick');
    for (var ki = 0; ki < kickBtns.length; ki++) {
      kickBtns[ki].addEventListener('click', (function(btn) {
        return function(e) {
          e.stopPropagation();
          var token = btn.getAttribute('data-kick-token');
          if (confirm('Expulsar a este jugador?')) {
            S.socket.emit(EV.KICK_PLAYER, {
              roomCode: S.roomCode, hostToken: S.hostToken, targetSeatToken: token
            });
          }
        };
      })(kickBtns[ki]));
    }
  }
}

function renderPlayerBadge(p) {
  if (!p.mobileConnected && p.name) return '<span style="color:var(--pink);font-size:0.65rem;">Desconectado...</span>';
  if (p.isReady) return '<span class="badge-ready" style="font-size:0.65rem;">✓ Confirmado</span>';
  if (p.name)    return '<span class="badge badge-linked">Eligiendo</span>';
  return '<span class="badge badge-qr">QR</span>';
}

function findCar(carId) {
  for (var i = 0; i < CARS.length; i++) { if (CARS[i].id === carId) return CARS[i]; }
  return null;
}

function findWeapon(weaponId) {
  for (var i = 0; i < WEAPONS.length; i++) { if (WEAPONS[i].id === weaponId) return WEAPONS[i]; }
  return null;
}

/* ------------------------------------------------- admin settings */
var ARCADE_MODE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

function syncAdminFormValues() {
  var mode   = $('admin-select-mode');
  var track  = $('admin-select-track');
  var laps   = $('admin-select-laps');
  var ammo   = $('admin-select-ammo');
  var idist  = $('admin-select-itemdist');
  if (mode)  mode.value  = S.settings.mode            || 'championship';
  if (track) track.value = S.settings.trackId          || 'track_01_neon_city';
  if (laps)  laps.value  = String(S.settings.laps      || 3);
  if (ammo)  ammo.value  = String(S.settings.ammoMultiplier || 1.0);
  if (idist) idist.value = S.settings.itemDistribution || 'balanced';
  var trackCount = $('admin-select-trackcount');
  if (trackCount) trackCount.value = String(S.settings.trackCount || 40);
  var trackCountG = $('admin-trackcount-group');
  if (trackCountG) trackCountG.style.display = (S.settings.mode === 'championship') ? '' : 'none';

  var summary = $('admin-format-summary');
  if (summary) {
    if (S.settings.mode === 'championship') {
      summary.style.display = '';
      summary.textContent = '🏁 ' + (S.settings.trackCount || 40) + ' pistas × ' + (S.settings.laps || 3) + ' vueltas';
    } else {
      summary.style.display = 'none';
    }
  }

  // Toggle visibility: show MUNICIÓN in classic, show DISTRIBUCIÓN in arcade
  var ammoG = $('admin-ammo-group'),  idistG = $('admin-itemdist-group');
  if (ammoG)  ammoG.style.display  = ARCADE_MODE ? 'none' : '';
  if (idistG) idistG.style.display = ARCADE_MODE ? '' : 'none';
}

function updateAdminSettings() {
  if (!S.socket || !S.hostToken) return;
  var mode  = $('admin-select-mode')     ? $('admin-select-mode').value                    : S.settings.mode;
  var tid   = $('admin-select-track')    ? $('admin-select-track').value                   : S.settings.trackId;
  var laps  = $('admin-select-laps')     ? parseInt($('admin-select-laps').value, 10)       : S.settings.laps;
  var trackCount = $('admin-select-trackcount') ? parseInt($('admin-select-trackcount').value, 10) : (S.settings.trackCount || 40);
  var ammo  = $('admin-select-ammo')     ? parseFloat($('admin-select-ammo').value)         : S.settings.ammoMultiplier;
  var idist = $('admin-select-itemdist') ? $('admin-select-itemdist').value                : S.settings.itemDistribution;
  S.settings = merge(S.settings, { mode: mode, trackId: tid, laps: laps, trackCount: trackCount, ammoMultiplier: ammo, itemDistribution: idist });
  syncAdminFormValues();
  S.socket.emit(EV.UPDATE_SETTINGS, { roomCode: S.roomCode, hostToken: S.hostToken, settings: S.settings });
}

function handleStartGame() {
  if (!S.socket || !S.hostToken) return;
  var unready = [];
  for (var i = 0; i < S.players.length; i++) {
    if (!S.players[i].isReady && S.players[i].name) unready.push(S.players[i].name);
  }
  if (unready.length > 0) {
    if (!confirm('Hay pilotos sin confirmar su vehículo (' + unready.join(', ') + '). ¿Iniciar de todos modos asignándoles su carro actual?')) return;
  }
  var btn = $('btn-start-game');
  if (btn) { btn.disabled = true; btn.textContent = 'INICIANDO...'; }
  S.socket.emit(EV.START_GAME, { roomCode: S.roomCode, hostToken: S.hostToken });
}

/* --------------------------------------------------- wire buttons */
function wireButtons() {
  var btnCreate = $('btn-create');
  if (btnCreate) {
    btnCreate.addEventListener('click', function() {
      window.triggerCreateRoom();
    });
    console.log('[wireButtons] btn-create wired');
  } else {
    console.warn('[wireButtons] btn-create NOT FOUND');
  }

  var btnShareHeader = $('btn-share-header');
  if (btnShareHeader) btnShareHeader.addEventListener('click', function() { copyText(S.inviteUrl, 'Enlace de invitacion'); });

  var btnCopyInvite = $('btn-copy-invite');
  if (btnCopyInvite) btnCopyInvite.addEventListener('click', function() { copyText(S.inviteUrl, 'Enlace de invitacion'); });

  var btnCopyCtrl = $('btn-copy-ctrl');
  if (btnCopyCtrl) btnCopyCtrl.addEventListener('click', function() { copyText(S.ctrlUrl, 'Enlace de control'); });

  var btnCopyAdmin = $('btn-copy-admin');
  if (btnCopyAdmin) btnCopyAdmin.addEventListener('click', function() { copyText(S.inviteUrl, 'Enlace de invitacion'); });

  var btnOpenAdmin = $('btn-open-admin');
  if (btnOpenAdmin) btnOpenAdmin.addEventListener('click', function() {
    var ap = $('admin-panel'); if (ap) ap.classList.add('open');
  });

  var btnCloseAdmin = $('btn-close-admin');
  if (btnCloseAdmin) btnCloseAdmin.addEventListener('click', function() {
    var ap = $('admin-panel'); if (ap) ap.classList.remove('open');
  });

  var btnCarPrev = $('btn-car-prev');
  if (btnCarPrev) btnCarPrev.addEventListener('click', function() { selectCar(S.selectedCarIndex - 1); });

  var btnCarNext = $('btn-car-next');
  if (btnCarNext) btnCarNext.addEventListener('click', function() { selectCar(S.selectedCarIndex + 1); });

  var btnReady = $('btn-toggle-ready');
  if (btnReady) btnReady.addEventListener('click', toggleReady);

  var selMode   = $('admin-select-mode');     if (selMode)   selMode.addEventListener('change',   updateAdminSettings);
  var selTCount = $('admin-select-trackcount');if (selTCount) selTCount.addEventListener('change',  updateAdminSettings);
  var selTrack  = $('admin-select-track');    if (selTrack)  selTrack.addEventListener('change',  updateAdminSettings);
  var selLaps   = $('admin-select-laps');     if (selLaps)   selLaps.addEventListener('change',   updateAdminSettings);
  var selAmmo   = $('admin-select-ammo');     if (selAmmo)   selAmmo.addEventListener('change',   updateAdminSettings);
  var selIdist  = $('admin-select-itemdist'); if (selIdist)  selIdist.addEventListener('change',  updateAdminSettings);
  // Initial visibility toggle based on mode
  syncAdminFormValues();

  var btnStart = $('btn-start-game');
  if (btnStart) btnStart.addEventListener('click', handleStartGame);
}

/* ---------------------------------------------------------------- boot */
function boot() {
  console.log('[boot] Road Rumble v3.0 - host screen');

  try { drawLogo();    } catch(e) { console.error('[boot] drawLogo:', e); }
  try { wireButtons(); } catch(e) { console.error('[boot] wireButtons:', e); }
  try { initSocket();  } catch(e) { console.error('[boot] initSocket:', e); }

  console.log('[boot] done. Socket:', S.socket ? 'created' : 'FAILED');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
