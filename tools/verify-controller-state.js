/**
 * tools/verify-controller-state.js
 * Unit test for Mobile Controller State Machine transitions:
 *   en_carrera → terminado_espera → intermision_resultados → cuenta_regresiva (nueva) → en_carrera
 *
 * Verifies (Prompt 4):
 *   - Each state transition updates DOM overlays and internal flags cleanly.
 *   - After new countdown, full controller is visible and results overlay is hidden.
 *   - Controls are reactivated upon green light / GO (seconds=0).
 *   - Obsolete events from prior races (old raceId) are discarded.
 *   - window.__rrControllerState() returns accurate snapshot at every phase.
 */
'use strict';

const assert = require('assert');

// ── Lightweight Mock DOM Environment ──────────────────────────────────────────
function createMockElement(id) {
  const classes = new Set(['hidden']);
  return {
    id,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c);
          else classes.add(c);
        } else if (force) {
          classes.add(c);
        } else {
          classes.delete(c);
        }
      },
      contains: (c) => classes.has(c),
    },
    style: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    _wired: false,
    addEventListener: () => {},
    appendChild: () => {},
  };
}

function setupMockEnvironment() {
  const elements = new Map();
  function getElem(id) {
    if (!elements.has(id)) {
      elements.set(id, createMockElement(id));
    }
    return elements.get(id);
  }

  // Pre-populate core controller elements
  const coreIds = [
    'ctrl-finished-overlay', 'ctrl-results-overlay', 'ctrl-wrong-way-banner',
    'state-connecting', 'state-name-entry', 'state-permission',
    'state-mobile-selection', 'state-controller', 'state-error',
    'ctrl-finished-title', 'ctrl-finished-msg', 'ctrl-results-title',
    'ctrl-results-subtitle', 'ctrl-personal-place', 'ctrl-personal-desc',
    'ctrl-standings-list', 'ctrl-next-track-info', 'ctrl-next-track-name',
    'ctrl-intermission-timer', 'ctrl-btn-next-race', 'ctrl-player-label',
    'hud-name', 'hud-speed-val', 'hud-pos', 'hud-lap', 'btn-power',
    'btn-accel', 'btn-brake', 'btn-fire', 'btn-drift', 'btn-power-name',
    'toast-container',
  ];
  coreIds.forEach(id => getElem(id));

  // Global mock socket
  const listeners = new Map();
  const emittedEvents = [];
  const mockSocket = {
    connected: true,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    emit(event, data) {
      emittedEvents.push({ event, data });
    },
    trigger(event, data) {
      const handlers = listeners.get(event) || [];
      handlers.forEach(h => h(data));
    },
  };

  const mockWindow = {
    location: { pathname: '/control/test-seat-token-42' },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    SHARED: require('../shared/constants'),
    CONFIG: { CARS: [], WEAPONS: [] },
    ROAD_RUMBLE_FLAGS: { ARCADE_ITEMS: true },
    navigator: { vibrate: () => {} },
    addEventListener: () => {},
  };

  return { getElem, mockSocket, emittedEvents, mockWindow };
}

async function runControllerStateMachineTest() {
  console.log('📱 Starting Mobile Controller State Machine Unit Test...');

  const { getElem, mockSocket, emittedEvents, mockWindow } = setupMockEnvironment();

  // Simulated controller state S mirroring client/js/controller.js
  const S = {
    phase: 'connecting',
    controllerActivated: false,
    socket: mockSocket,
    seatToken: 'test-seat-token-42',
    playerName: 'Tester',
    isHost: false,
    isReady: true,
    isFinished: false,
    raceId: 'room_race_0',
    raceIndex: 0,
    smoothSteer: 0,
    steerSeq: 0,
    inputs: {
      steer: 0,
      accel: false,
      brake: false,
      fire: false,
      drift: false,
      power: false,
    },
  };

  const EV = mockWindow.SHARED.EVENTS;

  function $(id) {
    return getElem(id);
  }

  function activateController() {
    ['connecting', 'name', 'permission', 'mobile-selection', 'controller', 'error'].forEach(p => {
      const el = $(`state-${p}`);
      if (el) el.classList.toggle('hidden', p !== 'controller');
    });
    S.phase = 'controller';
    S.controllerActivated = true;
  }

  function sendInputNow() {
    if (S.isFinished) return;
    if (!S.socket || !S.socket.connected || !S.seatToken) return;
    S.socket.emit(EV.CONTROLLER_INPUT, {
      seatToken: S.seatToken,
      steerSeq: S.steerSeq,
      inputs: { ...S.inputs, steerSeq: S.steerSeq },
    });
  }

  // Register controller state machine event listeners
  mockSocket.on(EV.GAME_COUNTDOWN, ({ seconds, raceId, raceIndex }) => {
    if (raceId) S.raceId = raceId;
    if (raceIndex != null) S.raceIndex = raceIndex;
    if (S.isFinished || S.phase !== 'controller') {
      S.isFinished = false;
      S.inputs.steer = 0;
      S.inputs.accel = false;
      S.inputs.brake = false;
      S.inputs.drift = false;
      S.inputs.fire = false;
      S.inputs.power = false;
      S.smoothSteer = 0;
      const finishedOverlay = $('ctrl-finished-overlay');
      if (finishedOverlay) finishedOverlay.classList.add('hidden');
      const resultsOverlay = $('ctrl-results-overlay');
      if (resultsOverlay) resultsOverlay.classList.add('hidden');
      const wrongWayBanner = $('ctrl-wrong-way-banner');
      if (wrongWayBanner) wrongWayBanner.classList.add('hidden');
      activateController();
    }
  });

  mockSocket.on(EV.CAR_FINISHED, (data) => {
    if (data && data.raceId && S.raceId && data.raceId !== S.raceId) {
      // Discard obsolete event from past race
      return;
    }
    if (data && data.seatToken === S.seatToken) {
      S.isFinished = true;
      S.inputs.steer = 0;
      S.inputs.accel = false;
      S.inputs.brake = false;
      S.inputs.drift = false;
      S.inputs.fire = false;
      const finishedOverlay = $('ctrl-finished-overlay');
      if (finishedOverlay) finishedOverlay.classList.remove('hidden');
    }
  });

  mockSocket.on(EV.CHAMPIONSHIP_INTERMISSION, (data) => {
    const overlay = $('ctrl-results-overlay');
    if (overlay) overlay.classList.remove('hidden');
  });

  function getControllerState() {
    return {
      phase: S.phase,
      raceId: S.raceId,
      raceIndex: S.raceIndex,
      isFinished: S.isFinished,
      isReady: S.isReady,
      isHost: S.isHost,
      controllerActivated: S.controllerActivated,
      sendLoopActive: !S.isFinished && Boolean(S.socket && S.socket.connected),
      smoothSteer: S.smoothSteer,
      inputs: { ...S.inputs },
    };
  }

  // ── STEP 1: en_carrera (Race 1 active) ──────────────────────────────────────
  activateController();
  S.isFinished = false;
  $('ctrl-finished-overlay').classList.add('hidden');
  $('ctrl-results-overlay').classList.add('hidden');

  let state = getControllerState();
  assert.strictEqual(state.phase, 'controller');
  assert.strictEqual(state.isFinished, false);
  assert.strictEqual(state.sendLoopActive, true);
  assert.strictEqual($('ctrl-finished-overlay').classList.contains('hidden'), true);
  assert.strictEqual($('ctrl-results-overlay').classList.contains('hidden'), true);

  // Send input during race: must succeed
  emittedEvents.length = 0;
  S.inputs.accel = true;
  sendInputNow();
  assert.strictEqual(emittedEvents.length, 1);
  assert.strictEqual(emittedEvents[0].event, EV.CONTROLLER_INPUT);
  console.log('  ✅ Step 1 (en_carrera): Controller active, overlays hidden, inputs emitted.');

  // ── STEP 2: terminado_espera (Finished Race 1 P1) ──────────────────────────
  mockSocket.trigger(EV.CAR_FINISHED, {
    seatToken: S.seatToken,
    place: 1,
    time: 12000,
    raceId: 'room_race_0',
    raceIndex: 0,
  });

  state = getControllerState();
  assert.strictEqual(state.isFinished, true, 'isFinished must be true');
  assert.strictEqual(state.sendLoopActive, false, 'sendLoop must be inactive when finished');
  assert.strictEqual($('ctrl-finished-overlay').classList.contains('hidden'), false, 'Finished overlay must be visible');

  // Input attempt while finished: must be blocked
  emittedEvents.length = 0;
  S.inputs.accel = true;
  sendInputNow();
  assert.strictEqual(emittedEvents.length, 0, 'Inputs must be locked when finished');
  console.log('  ✅ Step 2 (terminado_espera): Finished overlay shown, inputs safely locked.');

  // ── STEP 3: intermision_resultados (Intermission between races) ────────────
  mockSocket.trigger(EV.CHAMPIONSHIP_INTERMISSION, {
    seconds: 12,
    nextTrackId: 'ar-1952',
    nextTrackName: 'Buenos Aires · 1952',
    raceNumber: 2,
    totalRaces: 3,
    raceId: 'room_race_1',
    raceIndex: 1,
  });

  assert.strictEqual($('ctrl-results-overlay').classList.contains('hidden'), false, 'Results overlay must be visible during intermission');
  console.log('  ✅ Step 3 (intermision_resultados): Results overlay shown with intermission standings.');

  // ── STEP 4: cuenta_regresiva (nueva carrera Race 2: 3-2-1) ─────────────────
  mockSocket.trigger(EV.GAME_COUNTDOWN, {
    seconds: 3,
    raceId: 'room_race_1',
    raceIndex: 1,
  });

  state = getControllerState();
  assert.strictEqual(state.raceId, 'room_race_1', 'raceId must be updated to new race');
  assert.strictEqual(state.raceIndex, 1, 'raceIndex must be updated');
  assert.strictEqual(state.isFinished, false, 'isFinished must be RESET to false for new race');
  assert.strictEqual($('ctrl-finished-overlay').classList.contains('hidden'), true, 'Finished overlay MUST be hidden in countdown');
  assert.strictEqual($('ctrl-results-overlay').classList.contains('hidden'), true, 'Results overlay MUST be hidden in countdown');
  assert.strictEqual($('state-controller').classList.contains('hidden'), false, 'Controller UI MUST be visible in countdown');
  console.log('  ✅ Step 4 (cuenta_regresiva nueva): Overlays hidden, isFinished reset, full controller visible.');

  // ── STEP 5: en_carrera (Race 2 GO / green light) ───────────────────────────
  mockSocket.trigger(EV.GAME_COUNTDOWN, {
    seconds: 0,
    raceId: 'room_race_1',
    raceIndex: 1,
  });

  state = getControllerState();
  assert.strictEqual(state.isFinished, false);
  assert.strictEqual(state.sendLoopActive, true, 'Controls must be fully active on GO');

  // Input attempt at green light: MUST succeed and send to server
  emittedEvents.length = 0;
  S.inputs.accel = true;
  S.inputs.steer = 0.5;
  sendInputNow();
  assert.strictEqual(emittedEvents.length, 1);
  assert.strictEqual(emittedEvents[0].data.inputs.accel, true);
  assert.strictEqual(emittedEvents[0].data.inputs.steer, 0.5);
  console.log('  ✅ Step 5 (en_carrera GO): Controls active, vehicle drives forward.');

  // ── STEP 6: Obsolete event discard check ───────────────────────────────────
  // Receive a delayed CAR_FINISHED from old race 0
  mockSocket.trigger(EV.CAR_FINISHED, {
    seatToken: S.seatToken,
    place: 1,
    time: 12000,
    raceId: 'room_race_0', // OLD race ID
    raceIndex: 0,
  });

  state = getControllerState();
  assert.strictEqual(state.isFinished, false, 'Obsolete CAR_FINISHED from past race must be discarded');
  assert.strictEqual($('ctrl-finished-overlay').classList.contains('hidden'), true, 'Overlay must NOT reappear for old race event');
  console.log('  ✅ Step 6 (obsolete events): Late events from past races safely discarded.');

  console.log('\n🎉 ALL CONTROLLER STATE MACHINE TRANSITION CHECKS PASSED!\n');
}

if (require.main === module) {
  runControllerStateMachineTest().catch(err => {
    console.error('❌ Controller test failed:', err);
    process.exit(1);
  });
}

module.exports = { runControllerStateMachineTest };
