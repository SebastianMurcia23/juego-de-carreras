/**
 * server/RoomManager.js
 * Manages rooms, seats, tokens, player loadouts, ready states, and admin settings.
 * All state lives in memory – no database required.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const QRCode          = require('qrcode');
const SHARED          = require('../shared/constants');
const GameRoom        = require('./GameRoom');

const CARS    = require('../config/cars');
const WEAPONS = require('../config/weapons');
const TRACKS  = require('../config/tracks');
const SCORING = require('../config/scoring');

const EV     = SHARED.EVENTS;
const STATES = SHARED.STATES;
const LIMITS = SHARED.LIMITS;

/* ─── QR code helpers ───────────────────────────────────────────────────── */
const QR_OPTS = {
  width: 280,
  margin: 2,
  errorCorrectionLevel: 'M',
  color: { dark: '#000000', light: '#ffffff' },
};

async function makeQR(url) {
  try {
    return await QRCode.toDataURL(url, QR_OPTS);
  } catch (e) {
    console.error('[QR] Generation failed:', e.message);
    return null;
  }
}

/* ─── RoomManager ───────────────────────────────────────────────────────── */
class RoomManager {
  constructor(io) {
    this.io = io;

    /** @type {Map<string, Room>} roomCode → Room */
    this.rooms = new Map();

    // Fast-lookup indexes
    /** @type {Map<string, string>} seatToken → roomCode */
    this.seatIndex = new Map();

    /** @type {Map<string, string>} hostToken → roomCode */
    this.hostIndex = new Map();

    /** @type {Map<string, {roomCode:string, seatToken:string|null, role:string}>} socketId → info */
    this.socketIndex = new Map();
  }

  /* ── Catalog configuration getters ────────────────────────────────────── */

  getConfigCatalog() {
    return {
      cars: CARS,
      weapons: WEAPONS,
      tracks: TRACKS,
      scoring: SCORING,
    };
  }

  /* ── Utility ─────────────────────────────────────────────────────────── */

  _genCode() {
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // omit I/O to avoid confusion
    let code;
    do {
      code = Array.from({ length: LIMITS.ROOM_CODE_LENGTH },
        () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  _getLocalIp() {
    const os = require('os');
    const nets = os.networkInterfaces();
    // Prioritize standard local private networks (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          if (net.address.startsWith('192.168.') || net.address.startsWith('10.') || (net.address.startsWith('172.') && !net.address.startsWith('172.17.'))) {
            return net.address;
          }
        }
      }
    }
    // Fallback to any non-internal IPv4
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }

  _getBaseUrl(socketId) {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
    const socket = this.io.sockets.sockets.get(socketId);
    const secure = socket ? socket.handshake.secure : false;
    let host = socket ? (socket.handshake.headers.host || 'localhost:3000') : 'localhost:3000';

    // If host is localhost or 127.0.0.1, replace the hostname with local LAN IP
    // so mobile devices scanning the QR code can actually reach this computer!
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      const port = host.split(':')[1] || '3000';
      const localIp = this._getLocalIp();
      host = `${localIp}:${port}`;
    }

    return `${secure ? 'https' : 'http'}://${host}`;
  }

  _socketJoinRoom(socketId, roomCode) {
    const s = this.io.sockets.sockets.get(socketId);
    if (s) s.join(roomCode);
  }

  _broadcastPlayers(roomCode) {
    const list = this._playerList(roomCode);
    this.io.to(roomCode).emit(EV.PLAYERS_UPDATED, { players: list });
  }

  _broadcastSettings(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    this.io.to(roomCode).emit(EV.SETTINGS_UPDATED, { settings: room.settings });
  }

  _playerList(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    return Array.from(room.seats.values())
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map(seat => ({
        seatToken:       seat.token,
        name:            seat.name,
        state:           seat.state,
        isHost:          seat.isHost,
        carId:           seat.carId,
        weaponId:        seat.weaponId,
        isReady:         Boolean(seat.isReady),
        mobileConnected: Boolean(seat.mobileSocketId),
        computerOnline:  Boolean(seat.computerSocketId),
      }));
  }

  /* ── Create room (host) ──────────────────────────────────────────────── */

  async createRoom(hostSocketId) {
    const base         = this._getBaseUrl(hostSocketId);
    const roomCode     = this._genCode();
    const hostToken    = uuidv4();
    const seatToken    = uuidv4();
    const controlUrl   = `${base}/control/${seatToken}`;
    const inviteUrl    = `${base}/join/${roomCode}`;

    const qrDataUrl = await makeQR(controlUrl);

    const defaultCarId = CARS[0]?.id || 'apex_venom';
    const defaultWeaponId = WEAPONS[0]?.id || 'vulcan_mg';

    /** @type {Seat} */
    const hostSeat = {
      token:            seatToken,
      computerSocketId: hostSocketId,
      mobileSocketId:   null,
      name:             null,
      state:            STATES.SEAT.QR,
      isHost:           true,
      joinOrder:        0,
      controlUrl,
      carId:            defaultCarId,
      weaponId:         defaultWeaponId,
      isReady:          false,
    };

    /** @type {Room} */
    const room = {
      code:        roomCode,
      hostToken,
      hostSocketId,
      hostTimer:   null,
      state:       STATES.ROOM.LOBBY,
      seats:       new Map([[seatToken, hostSeat]]),
      joinCounter: 1,
      settings: {
        mode: 'championship',
        trackId: TRACKS[0]?.id || 'track_01_neon_city',
        trackOrder: TRACKS.map(track => track.id),
        laps: 3,
        ammoMultiplier: 1.0,
        friendlyFire: true,
      },
      championship: {
        raceNumber: 0,
        standings: new Map(),
      },
    };

    this.rooms.set(roomCode, room);
    this.seatIndex.set(seatToken, roomCode);
    this.hostIndex.set(hostToken, roomCode);
    this.socketIndex.set(hostSocketId, { roomCode, seatToken, role: 'host_computer' });
    this._socketJoinRoom(hostSocketId, roomCode);

    return {
      roomCode,
      hostToken,
      seatToken,
      qrDataUrl,
      inviteUrl,
      controlUrl,
      settings: room.settings,
      config: this.getConfigCatalog(),
    };
  }

  /* ── Join room (guest computer screen) ──────────────────────────────── */

  async joinRoom(roomCode, computerSocketId) {
    const base = this._getBaseUrl(computerSocketId);
    const room = this.rooms.get(roomCode);

    if (!room)
      return { error: 'ROOM_NOT_FOUND' };
    if (room.state === STATES.ROOM.RACING)
      return { error: 'GAME_IN_PROGRESS' };
    if (room.seats.size >= LIMITS.MAX_PLAYERS)
      return { error: 'ROOM_FULL' };

    const seatToken  = uuidv4();
    const controlUrl = `${base}/control/${seatToken}`;
    const inviteUrl  = `${base}/join/${roomCode}`;
    const qrDataUrl  = await makeQR(controlUrl);

    // Assign different initial car rotating by join order
    const carIndex = room.joinCounter % CARS.length;
    const defaultCarId = CARS[carIndex]?.id || CARS[0]?.id || 'apex_venom';
    const defaultWeaponId = WEAPONS[0]?.id || 'vulcan_mg';

    /** @type {Seat} */
    const seat = {
      token:            seatToken,
      computerSocketId,
      mobileSocketId:   null,
      name:             null,
      state:            STATES.SEAT.QR,
      isHost:           false,
      joinOrder:        room.joinCounter++,
      controlUrl,
      carId:            defaultCarId,
      weaponId:         defaultWeaponId,
      isReady:          false,
    };

    room.seats.set(seatToken, seat);
    this.seatIndex.set(seatToken, roomCode);
    this.socketIndex.set(computerSocketId, { roomCode, seatToken, role: 'guest_computer' });
    this._socketJoinRoom(computerSocketId, roomCode);

    this._broadcastPlayers(roomCode);
    return {
      seatToken,
      qrDataUrl,
      roomCode,
      inviteUrl,
      settings: room.settings,
      config: this.getConfigCatalog(),
    };
  }

  /* ── Link mobile to seat ─────────────────────────────────────────────── */

  async linkSeat(seatToken, rawName, mobileSocketId) {
    const roomCode = this.seatIndex.get(seatToken);
    if (!roomCode) return { error: 'SEAT_INVALID' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(seatToken);
    if (!seat) return { error: 'SEAT_INVALID' };

    // If a different mobile is already actively connected, reject
    if (seat.mobileSocketId && seat.mobileSocketId !== mobileSocketId) {
      const existing = this.io.sockets.sockets.get(seat.mobileSocketId);
      if (existing) return { error: 'SEAT_ALREADY_USED' };
    }

    const name = (rawName || '').trim().slice(0, LIMITS.MAX_NAME_LENGTH) || 'Piloto';

    seat.mobileSocketId = mobileSocketId;
    seat.name           = name;
    seat.state          = STATES.SEAT.SELECTING;

    this.socketIndex.set(mobileSocketId, { roomCode, seatToken, role: 'mobile' });
    this._socketJoinRoom(mobileSocketId, roomCode);

    // Notify the computer screen of this specific seat
    if (seat.computerSocketId) {
      this.io.to(seat.computerSocketId).emit(EV.SEAT_LINKED, {
        name,
        seatToken,
        isHost: seat.isHost,
        carId: seat.carId,
        weaponId: seat.weaponId,
        isReady: seat.isReady,
      });
    }

    this._broadcastPlayers(roomCode);
    return {
      success: true,
      name,
      roomCode,
      isHost: seat.isHost,
      carId: seat.carId,
      weaponId: seat.weaponId,
      isReady: seat.isReady,
      roomState: room.state,
      settings: room.settings,
      config: this.getConfigCatalog(),
    };
  }

  /* ── Stage 2: Select Loadout (car & weapon) ─────────────────────────── */

  selectLoadout(seatToken, carId, weaponId) {
    const roomCode = this.seatIndex.get(seatToken);
    if (!roomCode) return { error: 'SEAT_INVALID' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(seatToken);
    if (!seat) return { error: 'SEAT_INVALID' };

    // If vehicle is already confirmed, lock changes until unlocked
    if (seat.isReady) {
      return { error: 'VEHICLE_CONFIRMED_LOCKED', message: 'Desbloquea tu vehículo con "Cambiar" para elegir otro.' };
    }

    // Validate car and weapon exist in catalog
    if (carId && CARS.some(c => c.id === carId)) {
      seat.carId = carId;
    }
    if (weaponId && WEAPONS.some(w => w.id === weaponId)) {
      seat.weaponId = weaponId;
    }

    // Notify whole room of player update
    this._broadcastPlayers(roomCode);

    // Notify specific seat targets (PC and Mobile)
    const payload = {
      seatToken,
      carId: seat.carId,
      weaponId: seat.weaponId,
      isReady: seat.isReady,
    };

    if (seat.computerSocketId) {
      this.io.to(seat.computerSocketId).emit(EV.LOADOUT_UPDATED, payload);
    }
    if (seat.mobileSocketId) {
      this.io.to(seat.mobileSocketId).emit(EV.LOADOUT_UPDATED, payload);
    }

    return { success: true, ...payload };
  }

  /* ── Stage 2: Toggle Ready ───────────────────────────────────────────── */

  toggleReady(seatToken, isReady) {
    const roomCode = this.seatIndex.get(seatToken);
    if (!roomCode) return { error: 'SEAT_INVALID' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(seatToken);
    if (!seat) return { error: 'SEAT_INVALID' };

    // Validate car exists
    if (!seat.carId || !CARS.some(c => c.id === seat.carId)) {
      seat.carId = CARS[0]?.id || 'apex_venom';
    }

    seat.isReady = Boolean(isReady);
    seat.state = seat.isReady ? STATES.SEAT.READY : STATES.SEAT.SELECTING;

    this._broadcastPlayers(roomCode);

    const payload = {
      seatToken,
      isReady: seat.isReady,
      state: seat.state,
    };

    if (seat.computerSocketId) {
      this.io.to(seat.computerSocketId).emit('ready_state_changed', payload);
    }
    if (seat.mobileSocketId) {
      this.io.to(seat.mobileSocketId).emit('ready_state_changed', payload);
    }

    return { success: true, ...payload };
  }

  /* ── Stage 2: Update Room Settings (Admin only) ───────────────────────── */

  updateRoomSettings(roomCode, hostToken, newSettings = {}) {
    if (!this.validateHostToken(roomCode, hostToken)) {
      return { error: 'UNAUTHORIZED' };
    }

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    if (newSettings.mode && ['championship', 'single'].includes(newSettings.mode)) {
      room.settings.mode = newSettings.mode;
    }
    if (newSettings.trackId && TRACKS.some(t => t.id === newSettings.trackId)) {
      room.settings.trackId = newSettings.trackId;
    }
    if (Array.isArray(newSettings.trackOrder) && newSettings.trackOrder.length) {
      const validTracks = newSettings.trackOrder.filter(id => TRACKS.some(track => track.id === id));
      if (validTracks.length) room.settings.trackOrder = validTracks;
    }
    if (newSettings.laps && Number.isInteger(Number(newSettings.laps))) {
      room.settings.laps = Math.max(1, Math.min(10, parseInt(newSettings.laps, 10)));
    }
    if (newSettings.ammoMultiplier !== undefined) {
      room.settings.ammoMultiplier = parseFloat(newSettings.ammoMultiplier) || 1.0;
    }
    if (newSettings.friendlyFire !== undefined) {
      room.settings.friendlyFire = Boolean(newSettings.friendlyFire);
    }

    this._broadcastSettings(roomCode);
    return { success: true, settings: room.settings };
  }

  /* ── Stage 2: Kick Player (Admin only) ────────────────────────────────── */

  kickPlayer(roomCode, hostToken, targetSeatToken) {
    if (!this.validateHostToken(roomCode, hostToken)) {
      return { error: 'UNAUTHORIZED' };
    }

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(targetSeatToken);
    if (!seat) return { error: 'PLAYER_NOT_FOUND' };
    if (seat.isHost) return { error: 'CANNOT_KICK_HOST' };

    // Notify and disconnect target's sockets
    const notifyKicked = (socketId) => {
      if (!socketId) return;
      const s = this.io.sockets.sockets.get(socketId);
      if (s) {
        s.emit(EV.PLAYER_KICKED, { message: 'Has sido expulsado de la sala por el administrador.' });
        s.leave(roomCode);
      }
      this.socketIndex.delete(socketId);
    };

    notifyKicked(seat.computerSocketId);
    notifyKicked(seat.mobileSocketId);

    room.seats.delete(targetSeatToken);
    this.seatIndex.delete(targetSeatToken);

    this._broadcastPlayers(roomCode);
    return { success: true, kickedSeatToken: targetSeatToken };
  }

  /* ── Stage 2/3: Start Game (Admin only) ──────────────────────────────── */

  startGame(roomCode, hostToken) {
    if (!this.validateHostToken(roomCode, hostToken)) {
      return { error: 'UNAUTHORIZED' };
    }

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    if (room.state === STATES.ROOM.RACING || room.state === STATES.ROOM.COUNTDOWN) {
      return { error: 'GAME_ALREADY_STARTED' };
    }

    // Need at least one linked player
    const linkedPlayers = Array.from(room.seats.values()).filter(s => s.name);
    if (linkedPlayers.length === 0) {
      return { error: 'NO_PLAYERS' };
    }

    // Ensure all unconfirmed players get a valid car and are marked confirmed
    for (const seat of linkedPlayers) {
      if (!seat.carId || !CARS.some(c => c.id === seat.carId)) {
        seat.carId = CARS[0]?.id || 'apex_venom';
      }
      seat.isReady = true;
      seat.state = STATES.SEAT.READY;
    }
    this._broadcastPlayers(roomCode);

    room.state = STATES.ROOM.COUNTDOWN;

    if (room.settings.mode === 'championship') {
      const order = room.settings.trackOrder || TRACKS.map(track => track.id);
      const trackId = order[room.championship.raceNumber] || order[order.length - 1];
      room.settings.trackId = trackId;
    }

    // Broadcast countdown start to everyone
    this.io.to(roomCode).emit(EV.GAME_STARTING, {
      countdownSeconds: 3,
      trackId: room.settings.trackId,
      mode: room.settings.mode,
      laps: room.settings.laps,
      players: this._playerList(roomCode),
    });

    // Create and start the GameRoom physics engine
    try {
      room.gameRoom = new GameRoom(this.io, roomCode, room);
      room.gameRoom.onFinish = (payload) => {
        this._handleRaceFinished(roomCode, payload);
      };
      room.gameRoom.start();
      room.state = STATES.ROOM.RACING;
      console.log(`[game] Room ${roomCode} game started!`);
    } catch (e) {
      console.error('[game] Failed to start GameRoom:', e);
      return { error: 'GAME_START_FAILED' };
    }

    return { success: true, state: room.state };
  }

  /* ── Championship progression & automated track rotation ─────────────── */

  _handleRaceFinished(roomCode, payload) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (room.settings.mode === 'championship') {
      if (payload.championshipFinished) {
        room.state = 'championship_finished';
        this.io.to(roomCode).emit(EV.CHAMPIONSHIP_FINISHED, {
          standings: payload.standings,
          totalRaces: payload.totalRaces,
        });
        console.log(`[championship] Room ${roomCode} championship finished! Winner: ${payload.standings[0]?.name}`);
      } else {
        const delayMs = (room.settings.intermissionSeconds || 12) * 1000;
        if (room.intermissionTimer) clearTimeout(room.intermissionTimer);
        room.intermissionTimer = setTimeout(() => {
          this.advanceChampionship(roomCode);
        }, delayMs);
        console.log(`[championship] Room ${roomCode} scheduled next race in ${delayMs / 1000}s`);
      }
    }
  }

  advanceChampionship(roomCode, hostToken = null) {
    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    if (hostToken && !this.validateHostToken(roomCode, hostToken)) {
      return { error: 'UNAUTHORIZED' };
    }
    if (room.intermissionTimer) {
      clearTimeout(room.intermissionTimer);
      room.intermissionTimer = null;
    }

    if (room.settings.mode !== 'championship') {
      return { error: 'NOT_CHAMPIONSHIP' };
    }

    room.championship.raceNumber++;
    const trackOrder = room.settings.trackOrder || TRACKS.map(t => t.id);
    if (room.championship.raceNumber >= trackOrder.length) {
      room.state = 'championship_finished';
      return { success: true, finished: true };
    }

    const nextTrackId = trackOrder[room.championship.raceNumber];
    room.settings.trackId = nextTrackId;

    if (room.gameRoom) {
      room.gameRoom.stop();
      room.gameRoom = null;
    }

    // Keep cumulative standings and player identities, reset per-race readiness
    for (const [, seat] of room.seats) {
      seat.state = STATES.SEAT.READY;
      seat.isReady = true;
    }

    room.state = STATES.ROOM.COUNTDOWN;

    this.io.to(roomCode).emit(EV.GAME_STARTING, {
      countdownSeconds: 3,
      trackId: nextTrackId,
      mode: 'championship',
      raceNumber: room.championship.raceNumber + 1,
      totalRaces: trackOrder.length,
      laps: room.settings.laps,
      players: this._playerList(roomCode),
    });

    try {
      room.gameRoom = new GameRoom(this.io, roomCode, room);
      room.gameRoom.onFinish = (payload) => {
        this._handleRaceFinished(roomCode, payload);
      };
      room.gameRoom.start();
      room.state = STATES.ROOM.RACING;
      console.log(`[championship] Room ${roomCode} started race ${room.championship.raceNumber + 1}/${trackOrder.length} (${nextTrackId})`);
    } catch (e) {
      console.error('[championship] Failed to start next race:', e);
      return { error: 'START_FAILED' };
    }

    return { success: true, raceNumber: room.championship.raceNumber + 1, trackId: nextTrackId };
  }

  /* ── Stage 3: Get active game room ─────────────────────────────────────── */

  getGameRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    return room ? room.gameRoom : null;
  }

  /* ── Stage 3: Find room by seat token ───────────────────────────────────── */

  getRoomCodeBySeat(seatToken) {
    return this.seatIndex.get(seatToken) || null;
  }

  /* ── Reconnect host computer ─────────────────────────────────────────── */

  async reconnectHost(roomCode, hostToken, newSocketId) {
    const storedCode = this.hostIndex.get(hostToken);
    if (!storedCode || storedCode !== roomCode) return { error: 'INVALID_TOKEN' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    // Cancel pending host-transfer timer
    if (room.hostTimer) {
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
    }

    room.hostSocketId = newSocketId;

    // Update the host seat's computer socket
    const hostSeat = Array.from(room.seats.values()).find(s => s.isHost);
    if (hostSeat) hostSeat.computerSocketId = newSocketId;

    this.socketIndex.set(newSocketId, { roomCode, seatToken: hostSeat?.token, role: 'host_computer' });
    this._socketJoinRoom(newSocketId, roomCode);

    const base    = this._getBaseUrl(newSocketId);
    let qrDataUrl = null;
    if (hostSeat && hostSeat.state === STATES.SEAT.QR) {
      qrDataUrl = await makeQR(hostSeat.controlUrl);
    }

    const inviteUrl = `${base}/join/${roomCode}`;

    this.io.to(roomCode).emit(EV.HOST_RECONNECTED);
    this._broadcastPlayers(roomCode);
    this._broadcastSettings(roomCode);

    return {
      success:     true,
      roomCode,
      hostToken,
      seatToken:   hostSeat?.token,
      qrDataUrl,
      inviteUrl,
      phoneLinked: hostSeat?.state !== STATES.SEAT.QR,
      playerName:  hostSeat?.name,
      carId:       hostSeat?.carId,
      weaponId:    hostSeat?.weaponId,
      isReady:     hostSeat?.isReady,
      players:     this._playerList(roomCode),
      roomState:   room.state,
      settings:    room.settings,
      config:      this.getConfigCatalog(),
    };
  }

  /* ── Reconnect guest computer screen ─────────────────────────────────── */

  async reconnectSeat(seatToken, newComputerSocketId) {
    const roomCode = this.seatIndex.get(seatToken);
    if (!roomCode) return { error: 'SEAT_INVALID' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(seatToken);
    if (!seat) return { error: 'SEAT_INVALID' };

    seat.computerSocketId = newComputerSocketId;
    this.socketIndex.set(newComputerSocketId, { roomCode, seatToken, role: 'guest_computer' });
    this._socketJoinRoom(newComputerSocketId, roomCode);

    let qrDataUrl = null;
    if (seat.state === STATES.SEAT.QR) {
      qrDataUrl = await makeQR(seat.controlUrl);
    }

    this._broadcastPlayers(roomCode);
    return {
      success:     true,
      seatToken,
      roomCode,
      qrDataUrl,
      state:       seat.state,
      name:        seat.name,
      carId:       seat.carId,
      weaponId:    seat.weaponId,
      isReady:     seat.isReady,
      phoneLinked: seat.state !== STATES.SEAT.QR,
      settings:    room.settings,
      config:      this.getConfigCatalog(),
    };
  }

  /* ── Reconnect mobile controller ─────────────────────────────────────── */

  async reconnectMobile(seatToken, newMobileSocketId) {
    const roomCode = this.seatIndex.get(seatToken);
    if (!roomCode) return { error: 'SEAT_INVALID' };

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const seat = room.seats.get(seatToken);
    if (!seat || !seat.name) return { error: 'SEAT_NOT_LINKED' };

    seat.mobileSocketId = newMobileSocketId;
    this.socketIndex.set(newMobileSocketId, { roomCode, seatToken, role: 'mobile' });
    this._socketJoinRoom(newMobileSocketId, roomCode);

    this._broadcastPlayers(roomCode);
    return {
      success: true,
      name: seat.name,
      roomCode,
      isHost: seat.isHost,
      carId: seat.carId,
      weaponId: seat.weaponId,
      isReady: seat.isReady,
      settings: room.settings,
      config: this.getConfigCatalog(),
    };
  }

  /* ── Handle socket disconnect ─────────────────────────────────────────── */

  handleDisconnect(socketId) {
    const info = this.socketIndex.get(socketId);
    if (!info) return;
    this.socketIndex.delete(socketId);

    const { roomCode, role } = info;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (role === 'host_computer') {
      this._handleHostDisconnect(room);
    } else if (role === 'guest_computer') {
      const seat = Array.from(room.seats.values()).find(s => s.computerSocketId === socketId);
      if (seat) {
        seat.computerSocketId = null;
        this._broadcastPlayers(roomCode);
      }
    } else if (role === 'mobile') {
      const seat = Array.from(room.seats.values()).find(s => s.mobileSocketId === socketId);
      if (seat) {
        seat.mobileSocketId = null;
        // Notify the seat's computer that the phone disconnected
        if (seat.computerSocketId) {
          this.io.to(seat.computerSocketId).emit(EV.PLAYER_DISCONNECTED, {
            seatToken: seat.token,
            name:      seat.name,
            role:      'mobile',
          });
        }
        this._broadcastPlayers(roomCode);
      }
    }
  }

  _handleHostDisconnect(room) {
    this.io.to(room.code).emit(EV.HOST_DISCONNECTED, {
      reconnectWindowMs: LIMITS.HOST_RECONNECT_TIMEOUT_MS,
    });

    room.hostTimer = setTimeout(() => {
      this._transferHost(room);
    }, LIMITS.HOST_RECONNECT_TIMEOUT_MS);
  }

  _transferHost(room) {
    // Oldest connected non-host
    const candidates = Array.from(room.seats.values())
      .filter(s => !s.isHost && s.computerSocketId && s.name)
      .sort((a, b) => a.joinOrder - b.joinOrder);

    if (candidates.length === 0) {
      this._closeRoom(room.code);
      return;
    }

    const newHost      = candidates[0];
    const newHostToken = uuidv4();

    this.hostIndex.delete(room.hostToken);
    room.hostToken    = newHostToken;
    room.hostSocketId = newHost.computerSocketId;
    newHost.isHost    = true;
    this.hostIndex.set(newHostToken, room.code);

    // Mark old host seat as non-host (if still in room)
    for (const [, seat] of room.seats) {
      if (seat.isHost && seat.token !== newHost.token) seat.isHost = false;
    }

    this.io.to(newHost.computerSocketId).emit(EV.HOST_TRANSFERRED, {
      newHostToken,
      message: 'Eres el nuevo administrador de la sala',
    });

    this._broadcastPlayers(room.code);
  }

  _closeRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    if (room.hostTimer) clearTimeout(room.hostTimer);

    for (const [token] of room.seats) this.seatIndex.delete(token);
    this.hostIndex.delete(room.hostToken);
    this.rooms.delete(roomCode);

    this.io.to(roomCode).emit(EV.ERROR, { message: 'La sala fue cerrada' });
  }

  /* ── Validation ──────────────────────────────────────────────────────── */

  validateHostToken(roomCode, hostToken) {
    return this.hostIndex.get(hostToken) === roomCode;
  }

  /* ── Public getters ──────────────────────────────────────────────────── */

  getRoomInfo(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    return {
      code:        room.code,
      state:       room.state,
      playerCount: room.seats.size,
      maxPlayers:  LIMITS.MAX_PLAYERS,
      isFull:      room.seats.size >= LIMITS.MAX_PLAYERS,
      settings:    room.settings,
      championship: room.championship ? {
        raceNumber: room.championship.raceNumber,
        standings: Array.from(room.championship.standings.values()),
      } : null,
    };
  }
}

module.exports = RoomManager;
