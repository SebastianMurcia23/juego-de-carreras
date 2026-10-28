/**
 * server/index.js
 * Entry point – Express + Socket.IO server for Road Rumble.
 */
'use strict';

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
const RoomManager = require('./RoomManager');
const ProductManager = require('./ProductManager');
const SHARED      = require('../shared/constants');

const EV = SHARED.EVENTS;

/* ─── App setup ─────────────────────────────────────────────────────────── */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Increase ping timeout to handle flaky mobile connections
  pingTimeout:  20000,
  pingInterval: 10000,
});

const rooms = new RoomManager(io);
const products = new ProductManager();

/* ─── Static files (no-cache for live dev) ───────────────────────────────── */
const staticOpts = {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
};
app.use(express.static(path.join(__dirname, '../client'), staticOpts));
app.use('/vendor/three', express.static(path.join(__dirname, '../node_modules/three'), staticOpts));
app.use('/shared', express.static(path.join(__dirname, '../shared'), staticOpts));
app.use('/config', express.static(path.join(__dirname, '../config'), staticOpts));

/* ─── HTML routes ────────────────────────────────────────────────────────── */
// All SPA-like routes serve their respective HTML files
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../client/index.html')));

app.get('/join/:code', (_req, res) =>
  res.sendFile(path.join(__dirname, '../client/join.html')));

app.get('/control/:token', (_req, res) =>
  res.sendFile(path.join(__dirname, '../client/controller.html')));

/* ─── REST API ──────────────────────────────────────────────────────────── */
app.get('/api/room/:code', (req, res) => {
  const info = rooms.getRoomInfo(req.params.code.toUpperCase());
  if (!info) return res.status(404).json({ error: 'Room not found' });
  res.json(info);
});

app.get('/api/config', (_req, res) => res.json(rooms.getConfigCatalog()));

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/product/catalog', (_req, res) => res.json(products.catalog()));
app.get('/api/product/profile/:id', (req, res) => {
  const profile = products.getProfile(req.params.id);
  if (!profile) return res.status(400).json({ error: 'INVALID_PROFILE' });
  res.json(profile);
});
app.post('/api/product/profile', express.json(), (req, res) => {
  const profile = products.upsertProfile(req.body && req.body.id, req.body && req.body.name);
  res.status(200).json(profile);
});
app.post('/api/product/purchase', express.json(), (req, res) => {
  const result = products.purchase(req.body && req.body.profileId, req.body && req.body.cosmeticId);
  if (result && result.error) return res.status(400).json(result);
  res.json(result);
});
app.get('/api/product/leaderboard', (_req, res) => res.json({ entries: products.leaderboardTop() }));
app.post('/api/product/checkout', express.json(), (_req, res) => {
  res.status(501).json({
    error: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    message: 'Configura PAYMENT_PROVIDER y las credenciales del proveedor antes de aceptar pagos reales.',
  });
});

/* ─── Socket.IO ─────────────────────────────────────────────────────────── */
io.on('connection', (socket) => {
  const id = socket.id;
  console.log(`[+] ${id} connected`);

  /* ── Create room (host) ───────────────────────────────────────────────── */
  socket.on(EV.CREATE_ROOM, async () => {
    try {
      const result = await rooms.createRoom(id);
      socket.emit(EV.ROOM_CREATED, result);
      console.log(`[room] Created ${result.roomCode} by ${id}`);
    } catch (e) {
      console.error('[create_room]', e);
      socket.emit(EV.ERROR, { message: 'Error al crear la sala' });
    }
  });

  /* ── Join room (guest computer) ───────────────────────────────────────── */
  socket.on(EV.JOIN_ROOM, async ({ code } = {}) => {
    try {
      const upper  = (code || '').toUpperCase();
      const result = await rooms.joinRoom(upper, id);

      if (result.error === 'ROOM_NOT_FOUND') {
        socket.emit(EV.ROOM_NOT_FOUND, { message: `Sala "${upper}" no encontrada. Verifica el código.` });
      } else if (result.error === 'ROOM_FULL') {
        socket.emit(EV.ROOM_FULL, { message: 'La sala está llena (máx. 12 jugadores).' });
      } else if (result.error === 'GAME_IN_PROGRESS') {
        socket.emit(EV.ERROR, { message: 'La carrera ya está en curso. Entrarás como espectador.' });
      } else if (result.error) {
        socket.emit(EV.ERROR, { message: 'Error al unirse a la sala' });
      } else {
        socket.emit(EV.ROOM_JOINED, result);
        console.log(`[room] ${id} joined ${result.roomCode}`);
      }
    } catch (e) {
      console.error('[join_room]', e);
      socket.emit(EV.ERROR, { message: 'Error al unirse a la sala' });
    }
  });

  /* ── Link mobile controller to a seat ────────────────────────────────── */
  socket.on(EV.LINK_SEAT, async ({ seatToken, name } = {}) => {
    try {
      if (!seatToken) {
        socket.emit(EV.SEAT_INVALID, { message: 'Token de asiento inválido.' });
        return;
      }
      const result = await rooms.linkSeat(seatToken, name, id);

      if (result.error === 'SEAT_ALREADY_USED') {
        socket.emit(EV.SEAT_ALREADY_USED, {
          message: 'Este control ya está siendo usado. Escanea tu propio QR.',
        });
      } else if (result.error === 'SEAT_INVALID') {
        socket.emit(EV.SEAT_INVALID, { message: 'Código de control inválido o expirado.' });
      } else if (result.error) {
        socket.emit(EV.ERROR, { message: 'Error al vincular el control' });
      } else {
        // Confirm to the mobile
        socket.emit(EV.SEAT_LINKED, {
          success:   true,
          name:      result.name,
          isHost:    result.isHost,
          carId:     result.carId,
          weaponId:  result.weaponId,
          isReady:   result.isReady,
          roomState: result.roomState,
        });
        console.log(`[seat] Mobile ${id} linked as "${result.name}" in ${result.roomCode}`);
      }
    } catch (e) {
      console.error('[link_seat]', e);
      socket.emit(EV.ERROR, { message: 'Error al vincular el control' });
    }
  });

  /* ── Reconnect host computer ──────────────────────────────────────────── */
  socket.on(EV.RECONNECT_HOST, async ({ roomCode, hostToken } = {}) => {
    try {
      const result = await rooms.reconnectHost(
        (roomCode || '').toUpperCase(), hostToken, id
      );
      if (result.error) {
        socket.emit(EV.ERROR, { message: 'No se pudo reconectar como anfitrión.' });
      } else {
        socket.emit(EV.ROOM_CREATED, result); // reuse same event – full state
        console.log(`[reconnect] Host back in ${roomCode}`);
      }
    } catch (e) {
      console.error('[reconnect_host]', e);
    }
  });

  /* ── Reconnect guest computer screen ─────────────────────────────────── */
  socket.on(EV.RECONNECT_SEAT, async ({ seatToken } = {}) => {
    try {
      const result = await rooms.reconnectSeat(seatToken, id);
      if (result.error) {
        socket.emit(EV.ERROR, { message: 'No se pudo reconectar la pantalla.' });
      } else {
        socket.emit(EV.ROOM_JOINED, result);
      }
    } catch (e) {
      console.error('[reconnect_seat]', e);
    }
  });

  /* ── Reconnect mobile controller ──────────────────────────────────────── */
  socket.on(EV.RECONNECT_MOBILE, async ({ seatToken } = {}) => {
    try {
      const result = await rooms.reconnectMobile(seatToken, id);
      if (result.error) {
        socket.emit(EV.ERROR, { message: 'No se pudo reconectar el control.' });
      } else {
        socket.emit(EV.SEAT_LINKED, {
          success:     true,
          name:        result.name,
          isHost:      result.isHost,
          reconnected: true,
        });
      }
    } catch (e) {
      console.error('[reconnect_mobile]', e);
    }
  });

  /* ── Stage 2: Catalog config ─────────────────────────────────────────── */
  socket.on(EV.GET_CONFIG, () => {
    socket.emit(EV.CONFIG_DATA, rooms.getConfigCatalog());
  });

  /* ── Stage 2: Loadout selection (car & weapon) ────────────────────────── */
  socket.on(EV.SELECT_LOADOUT, ({ seatToken, carId, weaponId } = {}) => {
    try {
      const res = rooms.selectLoadout(seatToken, carId, weaponId);
      if (res.error) socket.emit(EV.ERROR, { message: res.error });
    } catch (e) {
      console.error('[select_loadout]', e);
    }
  });

  /* ── Stage 2: Toggle Ready state ──────────────────────────────────────── */
  socket.on(EV.TOGGLE_READY, ({ seatToken, isReady } = {}) => {
    try {
      const res = rooms.toggleReady(seatToken, isReady);
      if (res.error) socket.emit(EV.ERROR, { message: res.error });
    } catch (e) {
      console.error('[toggle_ready]', e);
    }
  });

  /* ── Stage 2: Admin settings update ──────────────────────────────────── */
  socket.on(EV.UPDATE_SETTINGS, ({ roomCode, hostToken, settings } = {}) => {
    try {
      const upper = (roomCode || '').toUpperCase();
      const res = rooms.updateRoomSettings(upper, hostToken, settings);
      if (res.error) {
        socket.emit(EV.ERROR, { message: res.error === 'UNAUTHORIZED' ? 'Solo el anfitrión puede cambiar ajustes.' : 'Error al actualizar ajustes.' });
      }
    } catch (e) {
      console.error('[update_settings]', e);
    }
  });

  /* ── Stage 2: Admin kick player ──────────────────────────────────────── */
  socket.on(EV.KICK_PLAYER, ({ roomCode, hostToken, targetSeatToken } = {}) => {
    try {
      const upper = (roomCode || '').toUpperCase();
      const res = rooms.kickPlayer(upper, hostToken, targetSeatToken);
      if (res.error) {
        socket.emit(EV.ERROR, { message: res.error });
      }
    } catch (e) {
      console.error('[kick_player]', e);
    }
  });

  /* ── Stage 2: Admin start game ───────────────────────────────────────── */
  socket.on(EV.START_GAME, ({ roomCode, hostToken } = {}) => {
    try {
      const upper = (roomCode || '').toUpperCase();
      const res = rooms.startGame(upper, hostToken);
      if (res.error) {
        socket.emit(EV.ERROR, { message: res.error === 'UNAUTHORIZED' ? 'Solo el anfitrión puede iniciar la carrera.' : res.error });
      }
    } catch (e) {
      console.error('[start_game]', e);
    }
  });

  /* ── Stage 2: Host skip intermission to next race ────────────────────── */
  socket.on(EV.NEXT_RACE, ({ roomCode, hostToken } = {}) => {
    try {
      const upper = (roomCode || '').toUpperCase();
      const res = rooms.advanceChampionship(upper, hostToken);
      if (res && res.error && res.error !== 'UNAUTHORIZED') {
        socket.emit(EV.ERROR, { message: 'No se pudo avanzar a la siguiente pista.' });
      }
    } catch (e) {
      console.error('[next_race]', e);
    }
  });

  /* ── Controller input (Stage 3) ──────────────────────────────────────── */
  socket.on(EV.CONTROLLER_INPUT, (data) => {
    if (!data || !data.seatToken || !data.inputs) return;
    const roomCode = rooms.getRoomCodeBySeat(data.seatToken);
    if (!roomCode) {
      // Debug: steer input received but no room found for this seat
      if (Math.abs(data.inputs.steer || 0) > 0.1 && !socket._debugLogThrottle) {
        socket._debugLogThrottle = true;
        console.log(`[debug] Steer=${(data.inputs.steer || 0).toFixed(2)} from seat ${data.seatToken} but NO ROOM found`);
        setTimeout(() => { socket._debugLogThrottle = false; }, 3000);
      }
      return;
    }
    const gameRoom = rooms.getGameRoom(roomCode);
    if (gameRoom) {
      gameRoom.setInput(data.seatToken, data.inputs);
      if (Math.abs(data.inputs.steer || 0) > 0.15 && !socket._steerAppliedLog) {
        socket._steerAppliedLog = true;
        console.log(`[steer-ok] Room ${roomCode} Steer=${(data.inputs.steer || 0).toFixed(2)} applied to car`);
        setTimeout(() => { socket._steerAppliedLog = false; }, 2000);
      }
    } else if (Math.abs(data.inputs.steer || 0) > 0.1 && !socket._debugLogThrottle2) {
      socket._debugLogThrottle2 = true;
      console.log(`[debug] Steer=${(data.inputs.steer || 0).toFixed(2)} room ${roomCode} found but NO gameRoom (game not started?)`);
      setTimeout(() => { socket._debugLogThrottle2 = false; }, 3000);
    }
  });

  socket.on(EV.STEERING_INPUT, (data) => {
    if (!data || !data.seatToken) return;
    const roomCode = rooms.getRoomCodeBySeat(data.seatToken);
    const gameRoom = roomCode && rooms.getGameRoom(roomCode);
    if (!gameRoom) return;
    gameRoom.setSteer(data.seatToken, data.steer, data.steerSeq);
    if (Math.abs(Number(data.steer) || 0) > 0.15 && !socket._steeringLog) {
      socket._steeringLog = true;
      console.log(`[steer-channel] Room ${roomCode} Steer=${Number(data.steer).toFixed(2)} applied`);
      setTimeout(() => { socket._steeringLog = false; }, 2000);
    }
  });

  /* ── Disconnect ───────────────────────────────────────────────────────── */
  socket.on('disconnect', (reason) => {
    console.log(`[-] ${id} disconnected (${reason})`);
    rooms.handleDisconnect(id);
  });
});

/* ─── Start ─────────────────────────────────────────────────────────────── */
const PORT = parseInt(process.env.PORT || '3000', 10);
const os   = require('os');
const https = require('https');
const fs    = require('fs');

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.') || net.address.startsWith('10.') || (net.address.startsWith('172.') && !net.address.startsWith('172.17.'))) {
          return net.address;
        }
      }
    }
  }
  return 'localhost';
}

const lanIp = getLanIp();

// Start primary HTTP server
server.listen(PORT, () => {
  console.log(`\n🏎️  Road Rumble  →  http://localhost:${PORT}`);
  console.log(`    Red Wi-Fi   →  http://${lanIp}:${PORT}`);
  if (process.env.BASE_URL) {
    console.log(`    Public URL  →  ${process.env.BASE_URL}`);
  } else {
    console.log(`    📱 Celular: Escanea el QR (tu celular y PC deben estar en el mismo Wi-Fi)`);
  }
});

// Start secondary HTTPS server (for mobile secure context gyroscope support)
const certPath = path.join(__dirname, '..', 'cert.pem');
const keyPath  = path.join(__dirname, '..', 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const cert = fs.readFileSync(certPath);
    const key  = fs.readFileSync(keyPath);
    const httpsServer = https.createServer({ key, cert }, app);
    io.attach(httpsServer);
    const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`    🔒 HTTPS Seguro →  https://${lanIp}:${HTTPS_PORT} (Permite giroscopio móvil)`);
      console.log();
    });
  } catch(e) {
    console.warn('[https] Could not start https server:', e.message);
  }
}
