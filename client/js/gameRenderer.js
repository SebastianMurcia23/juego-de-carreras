/**
 * client/js/gameRenderer.js
 * 2D Canvas race renderer for Road Rumble.
 * Renders the track, all cars, projectiles, mines, and HUD overlay.
 * Camera follows the local player's car.
 */
(function() {
'use strict';

/* ─── State ────────────────────────────────────────────────────────────── */
var GR = {
  canvas:     null,
  ctx:        null,
  track:      null,
  gameState:  null,
  localSeat:  null,
  camera:     { x: 0, y: 0, zoom: 1.2 },
  smoothCam:  { x: 0, y: 0 },
  running:    false,
  animFrame:  null,
  countdown:  0,
  countdownEnd: 0,
  raceFinished: false,
  results:    null,
  arrivals:   [],
  floatingTexts: [],
  powerEffects: [],
  chaseMotion: null,
  chaseBackdrop: null,
};

var CARS    = (window.CONFIG && window.CONFIG.CARS)    || [];
var WEAPONS = (window.CONFIG && window.CONFIG.WEAPONS) || [];
var PHY     = (window.SHARED && window.SHARED.PHYSICS) || {};

/* ─── Colors ───────────────────────────────────────────────────────────── */
var TERRAIN_COLORS = {
  asphalt: '#2a2d3a',
  dirt:    '#5c4a3a',
  grass:   '#2d4a2a',
  mud:     '#3d3322',
  sand:    '#6b5e3e',
  rock:    '#4a4a50',
  ice:     '#4a6070',
};

var ROAD_BORDER_COLOR  = '#ffffff18';
var ROAD_LINE_COLOR    = '#ffffff10';
var CHECKPOINT_COLOR   = '#ffffff08';
var FINISH_LINE_COLOR  = '#f72585';

/* ─── Init ─────────────────────────────────────────────────────────────── */
function init(canvasId, localSeatToken) {
  GR.canvas   = document.getElementById(canvasId);
  if (!GR.canvas) { console.error('[GR] Canvas not found:', canvasId); return; }
  GR.ctx      = GR.canvas.getContext('2d');
  GR.localSeat = localSeatToken;
  GR.running  = true;
  GR.raceFinished = false;
  GR.results  = null;
  GR.arrivals = [];
  GR.powerEffects = [];
  GR.chaseMotion = null;
  GR.chaseBackdrop = null;

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Start render loop
  if (GR.animFrame) cancelAnimationFrame(GR.animFrame);
  renderLoop();
}

function drawPowerEffects(ctx) {
  var now = Date.now();
  for (var i = GR.powerEffects.length - 1; i >= 0; i--) {
    var effect = GR.powerEffects[i];
    var progress = (now - effect.start) / effect.life;
    if (progress >= 1) {
      GR.powerEffects.splice(i, 1);
      continue;
    }
    var color = effect.type === 'lightning' ? '#8ecae6' :
      effect.type === 'rocket' ? '#ff7b00' :
      effect.type === 'banana' ? '#f4d35e' :
      effect.type === 'frenzy' ? '#ff6b35' : '#ffd166';
    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 4;
    if (effect.type === 'lightning') {
      ctx.beginPath();
      ctx.moveTo(0, -42 * progress);
      ctx.lineTo(-12, -18);
      ctx.lineTo(5, -12);
      ctx.lineTo(-5, 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 25 + progress * 80, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 14 + progress * 52, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-26, 0); ctx.lineTo(26, 0);
      ctx.moveTo(0, -26); ctx.lineTo(0, 26);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function triggerPowerEffect(effect) {
  if (!effect || effect.x == null || effect.y == null) return;
  GR.powerEffects.push({
    type: effect.type,
    x: effect.x,
    y: effect.y,
    start: Date.now(),
    life: effect.type === 'lightning' ? 850 : 650,
  });
}

function drawChaseCar(ctx, car, weapon, color) {
  var length = (car.dimensions && car.dimensions.length || 64) * 0.58;
  var width = (car.dimensions && car.dimensions.width || 36) * 0.58;
  var primary = car.color || color || '#00f5d4';
  var accent = car.accentColor || '#ffffff';
  ctx.save();
  ctx.scale(1.12, 1.12);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.ellipse(-2, 8, length * 0.72, width * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-length * 0.72, -width * 0.72);
  ctx.lineTo(length * 0.62, -width * 0.48);
  ctx.lineTo(length * 0.9, 0);
  ctx.lineTo(length * 0.62, width * 0.48);
  ctx.lineTo(-length * 0.72, width * 0.72);
  ctx.closePath();
  var body = ctx.createLinearGradient(-length, 0, length, 0);
  body.addColorStop(0, primary);
  body.addColorStop(0.65, primary);
  body.addColorStop(1, accent);
  ctx.fillStyle = body;
  ctx.strokeStyle = '#ffffffaa';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  // Visible tires give the player a stable reference for steering and motion.
  ctx.fillStyle = '#080b10';
  ctx.strokeStyle = '#606a78';
  ctx.lineWidth = 1;
  [
    [-length * 0.42, -width * 0.78],
    [ length * 0.36, -width * 0.78],
    [-length * 0.42,  width * 0.78],
    [ length * 0.36,  width * 0.78],
  ].forEach(function(wheel) {
    ctx.beginPath();
    ctx.ellipse(wheel[0], wheel[1], length * 0.16, width * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.fillStyle = '#10131b';
  ctx.fillRect(-length * 0.82, -width * 0.82, 6, width * 1.64);
  ctx.fillStyle = '#ff304f';
  ctx.fillRect(-length * 0.7, -width * 0.58, 5, 4);
  ctx.fillRect(-length * 0.7, width * 0.42, 5, 4);
  ctx.beginPath();
  ctx.moveTo(-length * 0.35, -width * 0.42);
  ctx.lineTo(length * 0.2, -width * 0.32);
  ctx.lineTo(length * 0.35, 0);
  ctx.lineTo(length * 0.2, width * 0.32);
  ctx.lineTo(-length * 0.35, width * 0.42);
  ctx.closePath();
  ctx.fillStyle = '#101b2b';
  ctx.fill();
  ctx.strokeStyle = '#8cecff99';
  ctx.stroke();
  if (weapon) {
    ctx.fillStyle = weapon.color || accent;
    ctx.fillRect(length * 0.1, -3, 13, 6);
  }

  ctx.restore();
}

function stop() {
  GR.running = false;
  if (GR.animFrame) {
    cancelAnimationFrame(GR.animFrame);
    GR.animFrame = null;
  }
}

function resizeCanvas() {
  if (!GR.canvas) return;
  var dpr = Math.min(1.25, window.devicePixelRatio || 1);
  GR.canvas.width  = Math.floor(GR.canvas.clientWidth * dpr);
  GR.canvas.height = Math.floor(GR.canvas.clientHeight * dpr);
  GR.chaseBackdrop = null;
}

/* ─── Data setters ─────────────────────────────────────────────────────── */
function setTrack(trackData) {
  GR.track = trackData;
  GR.chaseBackdrop = null;
  // Center camera on start
  if (trackData && trackData.startPositions && trackData.startPositions.length > 0) {
    GR.camera.x = trackData.startPositions[0].x;
    GR.camera.y = trackData.startPositions[0].y;
    GR.smoothCam.x = GR.camera.x;
    GR.smoothCam.y = GR.camera.y;
  }
}

function setGameState(state) {
  GR.gameState = state;
}

function setCountdown(seconds) {
  GR.countdown = seconds;
  GR.countdownEnd = Date.now() + seconds * 1000;
}

function setResults(results) {
  GR.raceFinished = true;
  GR.results = Array.isArray(results) ? { results: results } : results;
}

function setArrival(arrival) {
  if (!arrival || !arrival.seatToken) return;
  if (!GR.arrivals.some(function(item) { return item.seatToken === arrival.seatToken; })) {
    GR.arrivals.push(arrival);
  }
}

/* ─── Main render loop ─────────────────────────────────────────────────── */
function renderLoop() {
  if (!GR.running) return;
  GR.animFrame = requestAnimationFrame(renderLoop);

  var ctx = GR.ctx;
  var W   = GR.canvas.width;
  var H   = GR.canvas.height;

  try {
    ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, W, H);

  if (!GR.track || !GR.gameState) {
    drawWaiting(ctx, W, H);
    return;
  }

  // Render the track in fixed world space. Cars move over this scene; the
  // road is never re-centered around the local car.
  drawFixedTrackScene(ctx, W, H);

  // Draw HUD (screen-space)
  drawHUD(ctx, W, H);
  drawMiniMap(ctx, W, H);

  // Countdown overlay
  var remaining = Math.ceil((GR.countdownEnd - Date.now()) / 1000);
  if (remaining > 0 && remaining <= 5) {
    drawCountdown(ctx, W, H, remaining);
  }

  // Results overlay
    if (GR.raceFinished && GR.results) {
      drawResults(ctx, W, H);
    }
  } catch (error) {
    console.error('[GR] render frame failed:', error);
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);
    drawFallbackRace(ctx, W, H);
  }
}

function drawFallbackRace(ctx, W, H) {
  ctx.fillStyle = '#7d9c70';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#303744';
  ctx.beginPath();
  ctx.moveTo(W * 0.44, H * 0.25);
  ctx.lineTo(W * 0.56, H * 0.25);
  ctx.lineTo(W * 0.94, H);
  ctx.lineTo(W * 0.06, H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#eadca8';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(W * 0.44, H * 0.25);
  ctx.lineTo(W * 0.06, H);
  ctx.moveTo(W * 0.56, H * 0.25);
  ctx.lineTo(W * 0.94, H);
  ctx.stroke();
  if (m.k === 'banana') {
    ctx.fillStyle = '#6b4f1d';
    ctx.fillRect(-2, -8, 4, 5);
    ctx.fillStyle = '#f4d35e';
    ctx.beginPath();
    ctx.arc(0, 1, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  drawSimpleLocalCar(ctx, W / 2, H * 0.8, '#00f5d4');
}

/* ─── Camera ───────────────────────────────────────────────────────────── */
function updateCamera(W, H) {
  var localCar = getLocalCar();
  if (localCar) {
    var lookAhead = 125 + Math.min(90, (localCar.spd || 0) * 0.22);
    GR.camera.x = localCar.x + Math.cos(localCar.a) * lookAhead;
    GR.camera.y = localCar.y + Math.sin(localCar.a) * lookAhead;
  }

  var smoothing = 0.12;
  GR.smoothCam.x += (GR.camera.x - GR.smoothCam.x) * smoothing;
  GR.smoothCam.y += (GR.camera.y - GR.smoothCam.y) * smoothing;

  if (localCar) {
    var targetZoom = 1.08 - (localCar.spd / 500) * 0.16;
    targetZoom = Math.max(0.82, Math.min(1.12, targetZoom));
    GR.camera.zoom += (targetZoom - GR.camera.zoom) * 0.05;
  }
}

function drawFixedTrackScene(ctx, W, H) {
  var bounds = GR.track && GR.track.bounds;
  if (!bounds || !GR.track.checkpoints || !GR.track.checkpoints.length) {
    drawFallbackRace(ctx, W, H);
    return;
  }

  var padding = 70;
  var worldW = Math.max(1, bounds.maxX - bounds.minX);
  var worldH = Math.max(1, bounds.maxY - bounds.minY);
  var scale = Math.min((W - padding * 2) / worldW, (H - padding * 2) / worldH);
  scale = Math.max(0.12, Math.min(0.8, scale));
  var offsetX = (W - worldW * scale) / 2 - bounds.minX * scale;
  var offsetY = (H - worldH * scale) / 2 - bounds.minY * scale;

  ctx.fillStyle = '#263d2a';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  drawTrack(ctx);
  drawBoostPads(ctx);
  drawPickups(ctx);
  drawMines(ctx);
  drawProjectiles(ctx);
  drawCars(ctx);
  drawPowerEffects(ctx);
  ctx.restore();

  var local = getLocalCar();
  if (local) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TU VEHÍCULO', offsetX + local.x * scale, offsetY + local.y * scale - 32);
    ctx.restore();
  }
}

  function drawChaseScene(ctx, W, H) {
    var local = getLocalCar();
    if (!local || !GR.track || !GR.track.checkpoints.length) return;

    if (!GR.chaseMotion) {
      GR.chaseMotion = { x: local.x, y: local.y, a: local.a, spd: local.spd || 0 };
    }
    var motion = GR.chaseMotion;
    var isStopped = (local.spd || 0) <= 3;
    if (isStopped) {
      motion.x = local.x;
      motion.y = local.y;
      motion.a = local.a;
      motion.spd = 0;
    }
    if (!isStopped) {
      motion.x += (local.x - motion.x) * 0.28;
      motion.y += (local.y - motion.y) * 0.28;
      motion.a += normalizeAngle(local.a - motion.a) * 0.22;
      motion.spd += ((local.spd || 0) - motion.spd) * 0.14;
    }

    var horizon = H * 0.28;
    var roadBottom = H * 1.08;
    var points = [];
    var checkpoints = GR.track.checkpoints;
    var current = local.cp || 0;
    var count = Math.min(32, checkpoints.length);
    var viewDistance = 1800;
    var cos = Math.cos(motion.a);
    var sin = Math.sin(motion.a);

    drawCachedChaseBackdrop(ctx, W, H);

    for (var i = 0; i < count; i++) {
      var cp = checkpoints[(current + i) % checkpoints.length];
      var dx = cp.x - motion.x;
      var dy = cp.y - motion.y;
      var forward = dx * cos + dy * sin;
      var lateral = -dx * sin + dy * cos;
      if (forward < 20 || forward > viewDistance) continue;

      // Perspective projection: distant points converge at the horizon and
      // close points remain bounded inside the canvas.
      var depth = Math.max(0.02, Math.min(1, forward / viewDistance));
      var perspective = 240 / Math.max(120, forward);
      var projectedLateral = lateral * perspective;
      var curveX = W / 2 + Math.max(-W * 0.32, Math.min(W * 0.32, projectedLateral));
      var y = horizon + Math.pow(depth, 0.62) * (roadBottom - horizon);
      var halfWidth = Math.max(7, Math.min(W * 0.48, 7 + Math.pow(depth, 1.18) * W * 0.48));
      points.push({ x: curveX, y: y, w: halfWidth, terrain: cp.terrain || 'asphalt' });
    }

    points.push({ x: W / 2, y: horizon, w: 8, terrain: 'asphalt' });
    points.push({ x: W / 2, y: roadBottom, w: W * 0.48, terrain: 'asphalt' });
    points.sort(function(a, b) { return a.y - b.y; });

    for (var p = points.length - 2; p >= 0; p--) {
      var near = points[p + 1];
      var far = points[p];
      var terrainColor = TERRAIN_COLORS[near.terrain] || TERRAIN_COLORS.asphalt;
      ctx.fillStyle = terrainColor;
      ctx.beginPath();
      ctx.moveTo(far.x - far.w - 13, far.y);
      ctx.lineTo(far.x + far.w + 13, far.y);
      ctx.lineTo(near.x + near.w + 13, near.y);
      ctx.lineTo(near.x - near.w - 13, near.y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = p % 2 ? '#252b37' : '#303744';
      ctx.beginPath();
      ctx.moveTo(far.x - far.w, far.y);
      ctx.lineTo(far.x + far.w, far.y);
      ctx.lineTo(near.x + near.w, near.y);
      ctx.lineTo(near.x - near.w, near.y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#e7d9a5';
      ctx.fillRect(far.x - far.w - 3, far.y, 6, Math.max(2, near.y - far.y));
      ctx.fillRect(far.x + far.w - 3, far.y, 6, Math.max(2, near.y - far.y));

      if (p % 3 === 0) {
        ctx.fillStyle = '#f4e8ba';
        ctx.beginPath();
        ctx.moveTo(far.x - 3, far.y);
        ctx.lineTo(far.x + 3, far.y);
        ctx.lineTo(near.x + 12, near.y);
        ctx.lineTo(near.x - 12, near.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    drawChaseOpponents(ctx, W, H, local, motion);
    drawChaseProjectiles(ctx, W, H, motion);
    ctx.save();
    var speedRatio = Math.max(0, Math.min(1, (local.spd || 0) / 260));
    var steeringOffset = Math.max(-58, Math.min(58, (local.steer || 0) * 58));
    var steeringAngle = (local.steer || 0) * 0.1;
    var suspension = isStopped ? 0 : Math.sin(Date.now() / 105) * Math.min(4, (local.spd || 0) / 80);
    var forwardMotion = speedRatio * 22;
    ctx.translate(W / 2 + steeringOffset, H * 0.79 - forwardMotion + suspension);
    ctx.rotate(-Math.PI / 2 + steeringAngle);
    ctx.scale(1.28, 1.28);
    var localDef = window.CONFIG?.CARS?.find(function(c) { return c.id === local.cid; });
    var localWeapon = window.CONFIG?.WEAPONS?.find(function(w) { return w.id === local.wid; });
    drawChaseCar(ctx, localDef || { dimensions: { length: 64, width: 36 }, color: local.clr }, localWeapon, local.clr);
    ctx.restore();

    if (local.firing) {
      ctx.save();
      ctx.fillStyle = '#ffe36e';
      ctx.shadowColor = '#ff9f1c';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.69, 8 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawChaseOverlay(ctx, W, H);
  }

  function drawSimpleLocalCar(ctx, x, y, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 18, 48, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color || '#00f5d4';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-42, 20);
    ctx.lineTo(-34, -28);
    ctx.lineTo(0, -42);
    ctx.lineTo(34, -28);
    ctx.lineTo(42, 20);
    ctx.lineTo(24, 32);
    ctx.lineTo(-24, 32);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#162338';
    ctx.fillRect(-22, -22, 44, 22);
    ctx.fillStyle = '#ff304f';
    ctx.fillRect(-30, 13, 10, 6);
    ctx.fillRect(20, 13, 10, 6);
    ctx.restore();
  }

  function drawChaseProjectiles(ctx, W, H, motion) {
    if (!GR.gameState || !GR.gameState.projs) return;
    var cos = Math.cos(motion.a);
    var sin = Math.sin(motion.a);
    for (var i = 0; i < GR.gameState.projs.length; i++) {
      var projectile = GR.gameState.projs[i];
      var dx = projectile.x - motion.x;
      var dy = projectile.y - motion.y;
      var forward = dx * cos + dy * sin;
      if (forward < 10 || forward > 1100) continue;
      var lateral = -dx * sin + dy * cos;
      var depth = Math.max(0.03, Math.min(1, forward / 1100));
      var y = H * 0.28 + Math.pow(depth, 0.68) * H * 0.56;
      var x = W / 2 + lateral * (0.045 + depth * 0.68);
      var radius = Math.max(2, Math.min(10, (projectile.r || 3) * (0.4 + depth)));
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = projectile.c || '#ffd166';
      ctx.shadowColor = projectile.c || '#ffd166';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      if (projectile.explosive) {
        ctx.strokeStyle = '#ffffffaa';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function normalizeAngle(angle) {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  }

  function drawChaseEnvironment(ctx, W, H, points) {
    // Static roadside details are tied to the road segments, so they do not
    // shimmer or move independently from the track.
    for (var i = 2; i < points.length - 1; i += 3) {
      var far = points[i];
      var near = points[i + 1];
      var depth = i / points.length;
      var size = 3 + depth * 18;
      var side = i % 2 ? -1 : 1;
      var x = near.x + side * (near.w + size * 1.8);
      var y = near.y;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#6b4a32';
      ctx.fillRect(-size * 0.12, -size * 2.2, size * 0.24, size * 2.2);
      ctx.fillStyle = '#3c7546';
      ctx.beginPath();
      ctx.arc(0, -size * 2.7, size, 0, Math.PI * 2);
      ctx.arc(-size * 0.6, -size * 2.2, size * 0.75, 0, Math.PI * 2);
      ctx.arc(size * 0.6, -size * 2.2, size * 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawCachedChaseBackdrop(ctx, W, H) {
    var key = W + 'x' + H;
    if (!GR.chaseBackdrop || GR.chaseBackdrop.key !== key) {
      var canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var back = canvas.getContext('2d');
      var horizon = H * 0.28;
      var sky = back.createLinearGradient(0, 0, 0, horizon + 80);
      sky.addColorStop(0, '#527c9a');
      sky.addColorStop(0.52, '#a9c4c3');
      sky.addColorStop(1, '#d6c29b');
      back.fillStyle = sky;
      back.fillRect(0, 0, W, horizon + 100);
      back.fillStyle = '#78965e';
      back.fillRect(0, horizon + 52, W, H - horizon - 52);

      // Distant city silhouette.
      for (var i = 0; i < 16; i++) {
        var width = 18 + (i % 4) * 13;
        var height = 24 + ((i * 17) % 48);
        var x = (i * (W / 13)) - 20;
        var y = horizon + 46 - height;
        back.fillStyle = i % 3 === 0 ? '#c5bfae' : '#8d9996';
        back.fillRect(x, y, width, height);
        back.fillStyle = '#536d78';
        for (var row = 0; row < 4; row++) {
          back.fillRect(x + 4, y + 7 + row * 10, Math.max(4, width - 8), 3);
        }
      }

      // Static roadside tree clusters.
      for (var tree = 0; tree < 18; tree++) {
        var tx = (tree * 97) % W;
        var ty = horizon + 48 + (tree % 3) * 11;
        var radius = 8 + (tree % 4) * 3;
        back.fillStyle = '#315c3e';
        back.beginPath();
        back.arc(tx, ty, radius, 0, Math.PI * 2);
        back.arc(tx - radius * 0.8, ty + 5, radius * 0.65, 0, Math.PI * 2);
        back.arc(tx + radius * 0.8, ty + 5, radius * 0.65, 0, Math.PI * 2);
        back.fill();
      }
      GR.chaseBackdrop = { key: key, canvas: canvas };
    }
    ctx.drawImage(GR.chaseBackdrop.canvas, 0, 0);
  }

  function drawChaseOpponents(ctx, W, H, local, motion) {
    if (!GR.gameState || !GR.gameState.cars) return;
    for (var i = 0; i < GR.gameState.cars.length; i++) {
      var car = GR.gameState.cars[i];
      if (car.st === local.st || !car.alive) continue;
      var dx = car.x - motion.x;
      var dy = car.y - motion.y;
      var forward = dx * Math.cos(motion.a) + dy * Math.sin(motion.a);
      if (forward < 35 || forward > 900) continue;
      var lateral = -dx * Math.sin(motion.a) + dy * Math.cos(motion.a);
      var depth = Math.max(0.04, Math.min(1, forward / 900));
      var y = H * 0.28 + Math.pow(depth, 1.4) * H * 0.54;
      var x = W / 2 + lateral * (0.06 + depth * 0.7);
      var scale = 0.18 + depth * 0.72;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.rotate(-Math.PI / 2);
      var def = window.CONFIG?.CARS?.find(function(c) { return c.id === car.cid; });
      drawChaseCar(ctx, def || { dimensions: { length: 64, width: 36 }, color: car.clr }, null, car.clr);
      ctx.restore();
    }
  }

function drawChaseOverlay(ctx, W, H) {
  var local = getLocalCar();
  if (!local) return;

  // A static tint keeps the scene readable without animated post-processing.
  ctx.save();
  ctx.fillStyle = 'rgba(8, 14, 24, 0.08)';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function getLocalCar() {
  if (!GR.gameState || !GR.gameState.cars) return null;
  for (var i = 0; i < GR.gameState.cars.length; i++) {
    if (GR.gameState.cars[i].st === GR.localSeat) return GR.gameState.cars[i];
  }
  return GR.gameState.cars[0] || null;
}

/* ─── Draw Track ───────────────────────────────────────────────────────── */
function drawTrack(ctx) {
  var cps = GR.track.checkpoints;
  var hw  = GR.track.roadHalfWidth;

  if (!cps || cps.length < 2) return;

  // Draw road surface segments
  for (var i = 0; i < cps.length; i++) {
    var curr = cps[i];
    var next = cps[(i + 1) % cps.length];

    var dx = next.x - curr.x;
    var dy = next.y - curr.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.1) continue;

    var nx = -dy / len;
    var ny =  dx / len;

    // Wide shoulder gives the road a raised, dimensional edge.
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.moveTo(curr.x + nx * (hw + 12), curr.y + ny * (hw + 12));
    ctx.lineTo(next.x + nx * (hw + 12), next.y + ny * (hw + 12));
    ctx.lineTo(next.x - nx * (hw + 12), next.y - ny * (hw + 12));
    ctx.lineTo(curr.x - nx * (hw + 12), curr.y - ny * (hw + 12));
    ctx.closePath();
    ctx.fill();

    // Road fill
    var terrain = curr.terrain || 'asphalt';
    ctx.fillStyle = TERRAIN_COLORS[terrain] || TERRAIN_COLORS.asphalt;
    ctx.beginPath();
    ctx.moveTo(curr.x + nx * hw, curr.y + ny * hw);
    ctx.lineTo(next.x + nx * hw, next.y + ny * hw);
    ctx.lineTo(next.x - nx * hw, next.y - ny * hw);
    ctx.lineTo(curr.x - nx * hw, curr.y - ny * hw);
    ctx.closePath();
    ctx.fill();

    // Road border lines
    ctx.strokeStyle = ROAD_BORDER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(curr.x + nx * hw, curr.y + ny * hw);
    ctx.lineTo(next.x + nx * hw, next.y + ny * hw);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(curr.x - nx * hw, curr.y - ny * hw);
    ctx.lineTo(next.x - nx * hw, next.y - ny * hw);
    ctx.stroke();

    // Center line dashes
    if (i % 6 < 3) {
      ctx.strokeStyle = ROAD_LINE_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(curr.x, curr.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }
  }

  // Draw start/finish line
  var start = cps[0];
  var startNext = cps[1];
  if (start && startNext) {
    var sdx = startNext.x - start.x;
    var sdy = startNext.y - start.y;
    var slen = Math.sqrt(sdx * sdx + sdy * sdy);
    if (slen > 0) {
      var snx = -sdy / slen;
      var sny =  sdx / slen;

      ctx.strokeStyle = FINISH_LINE_COLOR;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(start.x + snx * hw, start.y + sny * hw);
      ctx.lineTo(start.x - snx * hw, start.y - sny * hw);
      ctx.stroke();

      // Checkered pattern
      var segs = 8;
      for (var s = 0; s < segs; s++) {
        if (s % 2 === 0) {
          var t = s / segs;
          var t2 = (s + 1) / segs;
          ctx.fillStyle = '#ffffff30';
          ctx.fillRect(
            start.x + snx * hw * (1 - 2 * t) - 3,
            start.y + sny * hw * (1 - 2 * t) - 3,
            6, 6
          );
        }
      }
    }
  }
}

/* ─── Draw Cars ────────────────────────────────────────────────────────── */
function drawCars(ctx) {
  if (!GR.gameState || !GR.gameState.cars) return;

  var cars = GR.gameState.cars;
  for (var i = 0; i < cars.length; i++) {
    var car = cars[i];
    if (!car.alive && !car.fin) {
      // Draw explosion
      drawExplosion(ctx, car.x, car.y);
      continue;
    }

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.a);

    var isLocal = (car.st === GR.localSeat);
    var color   = car.clr || '#00f5d4';
    var carDef = (window.CONFIG?.CARS?.find(c => c.id === car.cid)) || {
      id: car.cid || 'speeder',
      color: color,
      dimensions: { length: 54, width: 30 },
    };
    var weaponDef = window.CONFIG?.WEAPONS?.find(w => w.id === car.wid);

    // Invulnerability glow
    if (car.inv) {
      ctx.globalAlpha = 0.4 + Math.sin(Date.now() / 80) * 0.3;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 15;
    }
    if (car.star || car.frenzy) {
      ctx.globalAlpha = 0.65 + Math.sin(Date.now() / 70) * 0.25;
      ctx.shadowColor = car.star ? '#ffd166' : '#ff6b35';
      ctx.shadowBlur = 24;
    } else if (car.slowed) {
      ctx.shadowColor = '#8ecae6';
      ctx.shadowBlur = 18;
    }

    if (isLocal) {
      drawThirdPersonCar(ctx, carDef, weaponDef, color);
    } else if (window.CAR_RENDERER) {
      window.CAR_RENDERER.drawCar(ctx, 0, 0, carDef, weaponDef, 0, 0.65);
    } else {
      // Fallback: car oriented along +X (length 48, width 26)
      var halfL = 24, halfW = 13;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-halfL + 2, -halfW + 2, halfL * 2, halfW * 2);

      ctx.fillStyle = color;
      ctx.fillRect(-halfL, -halfW, halfL * 2, halfW * 2);

      // Windshield at front (+X)
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, -halfW * 0.7, halfL * 0.5, halfW * 1.4);

      // Accent stripe
      ctx.fillStyle = isLocal ? '#ffffff60' : '#00000040';
      ctx.fillRect(-halfL, -2, halfL * 2, 4);
    }

    function drawThirdPersonCar(ctx, car, weapon, color) {
      if (window.CAR_RENDERER && car) {
        window.CAR_RENDERER.drawCar(ctx, 0, 0, car, weapon, 0, 0.72);
        return;
      }
      var length = (car.dimensions && car.dimensions.length || 64) * 0.58;
      var width = (car.dimensions && car.dimensions.width || 36) * 0.58;
      var primary = car.color || color || '#00f5d4';
      var accent = car.accentColor || '#ffffff';

      ctx.save();
      ctx.scale(1.12, 1.12);
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.ellipse(-2, 8, length * 0.72, width * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // A tapered body with the rear closest to the camera.
      ctx.beginPath();
      ctx.moveTo(-length * 0.72, -width * 0.72);
      ctx.lineTo(length * 0.62, -width * 0.48);
      ctx.lineTo(length * 0.9, 0);
      ctx.lineTo(length * 0.62, width * 0.48);
      ctx.lineTo(-length * 0.72, width * 0.72);
      ctx.closePath();
      var body = ctx.createLinearGradient(-length, 0, length, 0);
      body.addColorStop(0, primary);
      body.addColorStop(0.62, primary);
      body.addColorStop(1, accent);
      ctx.fillStyle = body;
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();

      // Rear spoiler and tail lights are deliberately prominent from this view.
      ctx.fillStyle = '#10131b';
      ctx.fillRect(-length * 0.82, -width * 0.82, 6, width * 1.64);
      ctx.strokeStyle = accent;
      ctx.strokeRect(-length * 0.82, -width * 0.82, 6, width * 1.64);
      ctx.fillStyle = '#ff304f';
      ctx.shadowColor = '#ff304f';
      ctx.shadowBlur = 8;
      ctx.fillRect(-length * 0.7, -width * 0.58, 5, 4);
      ctx.fillRect(-length * 0.7, width * 0.42, 5, 4);
      ctx.shadowBlur = 0;

      // Raised cabin gives the car a simple 2.5D silhouette.
      ctx.beginPath();
      ctx.moveTo(-length * 0.35, -width * 0.42);
      ctx.lineTo(length * 0.2, -width * 0.32);
      ctx.lineTo(length * 0.35, 0);
      ctx.lineTo(length * 0.2, width * 0.32);
      ctx.lineTo(-length * 0.35, width * 0.42);
      ctx.closePath();
      ctx.fillStyle = '#101b2b';
      ctx.fill();
      ctx.strokeStyle = '#8cecff99';
      ctx.stroke();

      if (weapon) {
        ctx.fillStyle = weapon.color || accent;
        ctx.fillRect(length * 0.1, -3, 13, 6);
      }
      ctx.restore();
    }

    // Drift sparks (behind the car at -X)
    if (car.drift) {
      ctx.fillStyle = '#ffcc00';
      for (var sp = 0; sp < 4; sp++) {
        var sx = -24 - Math.random() * 12;
        var sy = -10 + Math.random() * 20;
        ctx.fillRect(sx, sy, 3, 3);
      }
    }

    // Boost flames (behind the car at -X)
    if (car.boost) {
      ctx.fillStyle = '#f72585';
      ctx.shadowColor = '#f72585';
      ctx.shadowBlur = 14;
      var flen = 20 + Math.random() * 10;
      ctx.beginPath();
      ctx.moveTo(-24, -8);
      ctx.lineTo(-24 - flen, 0);
      ctx.lineTo(-24, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fee440';
      ctx.beginPath();
      ctx.moveTo(-24, -4);
      ctx.lineTo(-24 - flen * 0.6, 0);
      ctx.lineTo(-24, 4);
      ctx.closePath();
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    // Shield Dome
    if (car.shield) {
      ctx.save();
      ctx.translate(car.x, car.y);
      var sPulse = 1 + Math.sin(Date.now() / 140) * 0.08;
      var sRadius = 26 * sPulse;
      ctx.strokeStyle = '#00f5d4';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#00f5d4';
      ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(0, 245, 212, 0.15)';
      ctx.beginPath();
      ctx.arc(0, 0, sRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (car.star || car.frenzy || car.slowed) {
      ctx.save();
      ctx.translate(car.x, car.y);
      var stateColor = car.star ? '#ffd166' : car.frenzy ? '#ff6b35' : '#8ecae6';
      ctx.strokeStyle = stateColor;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.65 + Math.sin(Date.now() / 100) * 0.25;
      ctx.beginPath();
      ctx.arc(0, 0, 30 + Math.sin(Date.now() / 130) * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Name tag
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.fillStyle = isLocal ? '#00f5d4' : '#ffffffaa';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(car.nm, 0, -32);

    // Position badge
    if (car.pos) {
      ctx.fillStyle = '#0a0d14cc';
      ctx.fillRect(-10, -48, 20, 14);
      ctx.fillStyle = car.pos === 1 ? '#ffd700' : car.pos === 2 ? '#c0c0c0' : car.pos === 3 ? '#cd7f32' : '#ffffff88';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('P' + car.pos, 0, -37);
    }

    // Health bar
    if (!car.fin) {
      var barW = 30;
      var barH = 3;
      var barX = -barW / 2;
      var barY = 24;
      ctx.fillStyle = '#ff000040';
      ctx.fillRect(barX, barY, barW, barH);
      var hpRatio = Math.max(0, car.hp / 100);
      ctx.fillStyle = hpRatio > 0.5 ? '#00ff6688' : hpRatio > 0.25 ? '#ffaa0088' : '#ff000088';
      ctx.fillRect(barX, barY, barW * hpRatio, barH);
    }

    ctx.restore();
  }
}

function drawExplosion(ctx, x, y) {
  var t = Date.now() % 1000;
  var r = 10 + t / 30;
  var alpha = Math.max(0, 1 - t / 600);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ff4400';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffcc00';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ─── Draw Boost Pads ──────────────────────────────────────────────────── */
function drawBoostPads(ctx) {
  if (!GR.track || !GR.track.boostPads) return;
  var now = Date.now();
  var anim = (now % 1000) / 1000;

  for (var i = 0; i < GR.track.boostPads.length; i++) {
    var pad = GR.track.boostPads[i];
    ctx.save();
    ctx.translate(pad.x, pad.y);
    ctx.rotate(pad.angle);

    // Pad plate
    ctx.fillStyle = '#101524';
    ctx.strokeStyle = '#00f5d488';
    ctx.lineWidth = 2;
    roundRect(ctx, -pad.w / 2, -pad.h / 2, pad.w, pad.h, 6);
    ctx.fill();
    ctx.stroke();

    // Chevrons
    ctx.fillStyle = '#00f5d4';
    ctx.shadowColor = '#00f5d4';
    ctx.shadowBlur = 10;
    for (var a = -1; a <= 1; a++) {
      var cx = a * 12 + (anim * 10 - 5);
      ctx.beginPath();
      ctx.moveTo(cx - 5, -8);
      ctx.lineTo(cx + 4, 0);
      ctx.lineTo(cx - 5, 8);
      ctx.lineTo(cx - 2, 8);
      ctx.lineTo(cx + 7, 0);
      ctx.lineTo(cx - 2, -8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ─── Draw Pickups ─────────────────────────────────────────────────────── */
function drawPickups(ctx) {
  if (!GR.gameState || !GR.gameState.pickups) return;
  var now = Date.now();
  var pks = GR.gameState.pickups;

  for (var i = 0; i < pks.length; i++) {
    var pk = pks[i];
    ctx.save();
    ctx.translate(pk.x, pk.y);

    if (!pk.act) {
      // Inactive / respawning pedestal
      ctx.fillStyle = '#22263888';
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff22';
      ctx.stroke();
      ctx.restore();
      continue;
    }

    var bob = Math.sin(now / 220 + i * 1.5) * 3;
    ctx.translate(0, bob);

    var color = '#fee440';
    var icon = '?';
    if (pk.t === 'item_box') { color = '#9b5de5'; icon = '?'; }
    if (pk.t === 'repair') { color = '#55a630'; icon = '🔧'; }
    else if (pk.t === 'ammo')   { color = '#fee440'; icon = '⚡'; }
    else if (pk.t === 'shield') { color = '#00f5d4'; icon = '🛡️'; }
    else if (pk.t === 'nitro')  { color = '#f72585'; icon = '💥'; }
    else if (pk.t === 'star')   { color = '#ffd166'; icon = '★'; }
    else if (pk.t === 'emp')    { color = '#4361ee'; icon = '⚡'; }
    else if (pk.t === 'bomb')   { color = '#e63946'; icon = '✹'; }
    else if (pk.t === 'banana') { color = '#f4d35e'; icon = '●'; }
    else if (pk.t === 'lightning') { color = '#8ecae6'; icon = 'ϟ'; }
    else if (pk.t === 'rocket') { color = '#ff7b00'; icon = '➤'; }
    else if (pk.t === 'frenzy') { color = '#ff6b35'; icon = '✦'; }

    // Glow aura
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = color + '33';
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fill();

    // Ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.stroke();

    // Icon
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, 0, 0);

    ctx.restore();
  }

  // Draw arcade item boxes if in ARCADE mode
  if (GR.gameState && GR.gameState.itemBoxes) {
    for (var b = 0; b < GR.gameState.itemBoxes.length; b++) {
      var box = GR.gameState.itemBoxes[b];
      if (!box.act) continue;
      ctx.save();
      ctx.translate(box.x, box.y);
      var bobB = Math.sin(now / 220 + b) * 3;
      ctx.translate(0, bobB);
      var hue = Math.floor((now / 20 + b * 40) % 360);
      ctx.fillStyle = 'hsl(' + hue + ', 85%, 60%)';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.fillRect(-12, -12, 24, 24);
      ctx.strokeRect(-12, -12, 24, 24);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 0);
      ctx.restore();
    }
  }
}

/* ─── Floating Texts ───────────────────────────────────────────────────── */
function addFloatingText(text, x, y, color) {
  GR.floatingTexts.push({
    text:  text,
    x:     x,
    y:     y,
    color: color || '#00f5d4',
    start: Date.now(),
    life:  1300,
  });
}

function drawFloatingTexts(ctx) {
  var now = Date.now();
  for (var i = GR.floatingTexts.length - 1; i >= 0; i--) {
    var ft = GR.floatingTexts[i];
    var elapsed = now - ft.start;
    if (elapsed >= ft.life) {
      GR.floatingTexts.splice(i, 1);
      continue;
    }
    var progress = elapsed / ft.life;
    var alpha = 1 - progress;
    var yOffset = progress * 35;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = ft.color;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = ft.color;
    ctx.shadowBlur = 10;
    ctx.fillText(ft.text, ft.x, ft.y - yOffset);
    ctx.restore();
  }
}

/* ─── Draw Projectiles ─────────────────────────────────────────────────── */
function drawProjectiles(ctx) {
  if (!GR.gameState) return;

  if (GR.gameState.projs) {
    for (var i = 0; i < GR.gameState.projs.length; i++) {
      var p = GR.gameState.projs[i];
      ctx.fillStyle = p.c || '#ffd166';
      ctx.shadowColor = p.c || '#ffd166';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r || 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // Arcade Discs
  if (GR.gameState.itemDiscs) {
    for (var d = 0; d < GR.gameState.itemDiscs.length; d++) {
      var disc = GR.gameState.itemDiscs[d];
      ctx.save();
      ctx.translate(disc.x, disc.y);
      ctx.fillStyle = '#2fbf71';
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Arcade Missiles
  if (GR.gameState.itemMissiles) {
    for (var m = 0; m < GR.gameState.itemMissiles.length; m++) {
      var miss = GR.gameState.itemMissiles[m];
      ctx.save();
      ctx.translate(miss.x, miss.y);
      ctx.rotate(miss.ang || 0);
      ctx.fillStyle = '#e24b4a';
      ctx.fillRect(-10, -5, 20, 10);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(10, -5); ctx.lineTo(16, 0); ctx.lineTo(10, 5);
      ctx.fill();
      ctx.restore();
    }
  }

  // Arcade Oils
  if (GR.gameState.itemOils) {
    for (var o = 0; o < GR.gameState.itemOils.length; o++) {
      var oil = GR.gameState.itemOils[o];
      ctx.save();
      ctx.translate(oil.x, oil.y);
      ctx.fillStyle = 'rgba(16, 16, 24, 0.9)';
      ctx.beginPath();
      ctx.arc(0, 0, oil.r || 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ─── Draw Mines ───────────────────────────────────────────────────────── */
function drawMines(ctx) {
  if (!GR.gameState || !GR.gameState.mines) return;

  for (var i = 0; i < GR.gameState.mines.length; i++) {
    var m = GR.gameState.mines[i];
    ctx.save();
    ctx.translate(m.x, m.y);

    // Pulsing glow if armed
    if (m.armed) {
      var pulse = 0.5 + Math.sin(Date.now() / 200) * 0.3;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = m.c || '#f72585';
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = m.armed ? (m.c || '#f72585') : '#666';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }
}

/* ─── HUD ──────────────────────────────────────────────────────────────── */
function drawHUD(ctx, W, H) {
  var local = getLocalCar();
  if (!local) return;

  var dpr = window.devicePixelRatio || 1;
  ctx.save();

  // Speed display (bottom-left)
  var speedFactor = (window.SHARED && window.SHARED.PHYSICS &&
    window.SHARED.PHYSICS.SPEED_DISPLAY_FACTOR) || 0.5;
  var speedKmh = Math.round(local.spd * speedFactor); // Convert px/s to dashboard km/h
  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, 16 * dpr, H - 90 * dpr, 140 * dpr, 74 * dpr, 10 * dpr);
  ctx.fill();

  ctx.fillStyle = '#00f5d4';
  ctx.font = 'bold ' + (36 * dpr) + 'px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(speedKmh, 24 * dpr, H - 40 * dpr);

  ctx.fillStyle = '#ffffffaa';
  ctx.font = (12 * dpr) + 'px sans-serif';
  ctx.fillText('km/h', 24 * dpr, H - 22 * dpr);

  // Position (top-left)
  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, 16 * dpr, 16 * dpr, 80 * dpr, 50 * dpr, 10 * dpr);
  ctx.fill();

  var posColor = local.pos === 1 ? '#ffd700' : local.pos === 2 ? '#c0c0c0' : local.pos === 3 ? '#cd7f32' : '#ffffff';
  ctx.fillStyle = posColor;
  ctx.font = 'bold ' + (28 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('P' + (local.pos || '?'), 56 * dpr, 48 * dpr);

  ctx.fillStyle = '#ffffffaa';
  ctx.font = (10 * dpr) + 'px sans-serif';
  ctx.fillText('POSICIÓN', 56 * dpr, 60 * dpr);

  // Lap counter (top-center)
  var laps = GR.gameState.laps || 3;
  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, W / 2 - 60 * dpr, 16 * dpr, 120 * dpr, 50 * dpr, 10 * dpr);
  ctx.fill();

  ctx.fillStyle = '#f72585';
  ctx.font = 'bold ' + (22 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  var currentLap = Math.min(laps, (local.lap || 0) + (local.fin ? 0 : 1));
  ctx.fillText(currentLap + '/' + laps, W / 2, 46 * dpr);

  ctx.fillStyle = '#ffffffaa';
  ctx.font = (10 * dpr) + 'px sans-serif';
  ctx.fillText('VUELTA', W / 2, 60 * dpr);

  // Health bar (bottom-center)
  var hpBarW = 200 * dpr;
  var hpBarH = 12 * dpr;
  var hpBarX = W / 2 - hpBarW / 2;
  var hpBarY = H - 40 * dpr;

  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, hpBarX - 4 * dpr, hpBarY - 4 * dpr, hpBarW + 8 * dpr, hpBarH + 8 * dpr, 6 * dpr);
  ctx.fill();

  ctx.fillStyle = '#ff000040';
  roundRect(ctx, hpBarX, hpBarY, hpBarW, hpBarH, 4 * dpr);
  ctx.fill();

  var hp = Math.max(0, local.hp / 100);
  ctx.fillStyle = hp > 0.5 ? '#00f5d4' : hp > 0.25 ? '#ffb703' : '#f72585';
  roundRect(ctx, hpBarX, hpBarY, hpBarW * hp, hpBarH, 4 * dpr);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold ' + (9 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('HP ' + local.hp, W / 2, hpBarY + hpBarH - 2 * dpr);

  // Ammo (bottom-right)
  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, W - 130 * dpr, H - 70 * dpr, 114 * dpr, 54 * dpr, 10 * dpr);
  ctx.fill();

  ctx.fillStyle = local.ammo > 0 ? '#fee440' : '#ff4444';
  ctx.font = 'bold ' + (24 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(local.ammo, W - 73 * dpr, H - 36 * dpr);

  ctx.fillStyle = '#ffffffaa';
  ctx.font = (10 * dpr) + 'px sans-serif';
  ctx.fillText('MUNICIÓN', W - 73 * dpr, H - 22 * dpr);

  // Not alive overlay
  if (!local.alive) {
    ctx.fillStyle = 'rgba(10, 13, 20, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f72585';
    ctx.font = 'bold ' + (40 * dpr) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DESTRUIDO', W / 2, H / 2 - 10 * dpr);
    ctx.fillStyle = '#ffffffaa';
    ctx.font = (16 * dpr) + 'px sans-serif';
    ctx.fillText('Reapareciendo...', W / 2, H / 2 + 20 * dpr);
  }

  // Finished overlay
  if (local.fin) {
    ctx.fillStyle = 'rgba(10, 13, 20, 0.4)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold ' + (48 * dpr) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🏁 P' + local.fp, W / 2, H / 2 - 10 * dpr);
    ctx.fillStyle = '#ffffffcc';
    ctx.font = (18 * dpr) + 'px sans-serif';
    ctx.fillText('¡Carrera completada!', W / 2, H / 2 + 30 * dpr);
  }

  ctx.restore();
}

/* ─── Mini Map ─────────────────────────────────────────────────────────── */
function drawMiniMap(ctx, W, H) {
  if (!GR.track || !GR.gameState) return;

  var dpr = window.devicePixelRatio || 1;
  var mapSize = 140 * dpr;
  var mapX    = W - mapSize - 16 * dpr;
  var mapY    = 16 * dpr;
  var pad     = 8 * dpr;

  // Background
  ctx.fillStyle = '#0a0d14cc';
  roundRect(ctx, mapX, mapY, mapSize, mapSize, 8 * dpr);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, mapX, mapY, mapSize, mapSize, 8 * dpr);
  ctx.clip();

  // Map transform
  var bounds  = GR.track.bounds;
  var worldW  = bounds.maxX - bounds.minX;
  var worldH  = bounds.maxY - bounds.minY;
  var scale   = (mapSize - pad * 2) / Math.max(worldW, worldH);

  var offsetX = mapX + pad + (mapSize - pad * 2 - worldW * scale) / 2;
  var offsetY = mapY + pad + (mapSize - pad * 2 - worldH * scale) / 2;

  // Track path
  var cps = GR.track.checkpoints;
  if (cps.length > 1) {
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(
      offsetX + (cps[0].x - bounds.minX) * scale,
      offsetY + (cps[0].y - bounds.minY) * scale
    );
    for (var i = 1; i < cps.length; i++) {
      ctx.lineTo(
        offsetX + (cps[i].x - bounds.minX) * scale,
        offsetY + (cps[i].y - bounds.minY) * scale
      );
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Start/finish marker remains visible even when the camera is elsewhere.
  var start = cps[0];
  if (start) {
    var sx = offsetX + (start.x - bounds.minX) * scale;
    var sy = offsetY + (start.y - bounds.minY) * scale;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#f72585';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Car dots
  var cars = GR.gameState.cars;
  for (var ci = 0; ci < cars.length; ci++) {
    var car = cars[ci];
    if (!car.alive && !car.fin) continue;
    var cx = offsetX + (car.x - bounds.minX) * scale;
    var cy = offsetY + (car.y - bounds.minY) * scale;

    var isLocal = car.st === GR.localSeat;
    ctx.fillStyle = isLocal ? '#00f5d4' : (car.clr || '#ffffff');
    ctx.beginPath();
    ctx.arc(cx, cy, isLocal ? 4 * dpr : 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  drawLeaderboard(ctx, W, H);
}

function drawLeaderboard(ctx, W, H) {
  if (!GR.gameState || !Array.isArray(GR.gameState.cars)) return;

  var dpr = window.devicePixelRatio || 1;
  var visibleCars = GR.gameState.cars.slice(0, 8);
  var panelWidth = Math.min(220 * dpr, W - 32 * dpr);
  var panelX = W - panelWidth - 16 * dpr;
  var panelY = 166 * dpr;
  var panelHeight = (30 + visibleCars.length * 20) * dpr;

  ctx.save();
  ctx.fillStyle = '#0a0d14dd';
  roundRect(ctx, panelX, panelY, panelWidth, panelHeight, 8 * dpr);
  ctx.fill();

  ctx.fillStyle = '#00f5d4';
  ctx.font = 'bold ' + (11 * dpr) + 'px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CLASIFICACIÓN', panelX + 10 * dpr, panelY + 16 * dpr);

  for (var i = 0; i < visibleCars.length; i++) {
    var car = visibleCars[i];
    var rowY = panelY + (31 + i * 20) * dpr;
    var isLocal = car.st === GR.localSeat;
    var positionColor = i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : '#ffffffaa';
    var name = String(car.nm || 'Piloto').substring(0, 14);

    ctx.fillStyle = isLocal ? '#00f5d4' : positionColor;
    ctx.font = 'bold ' + (10 * dpr) + 'px sans-serif';
    ctx.fillText((i + 1) + '. ' + name, panelX + 10 * dpr, rowY);

    ctx.textAlign = 'right';
    ctx.fillStyle = isLocal ? '#ffffff' : '#ffffffaa';
    ctx.font = (9 * dpr) + 'px sans-serif';
    ctx.fillText(car.fin ? 'LLEGÓ P' + car.fp : 'V' +
      Math.min(GR.gameState.laps || 3, (car.lap || 0) + 1) +
      '  ' + (car.pts || 0) + ' pts', panelX + panelWidth - 10 * dpr, rowY);
    ctx.textAlign = 'left';
  }
  if (GR.arrivals.length) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold ' + (10 * dpr) + 'px sans-serif';
    ctx.fillText('LLEGADAS: ' + GR.arrivals.length, panelX + 10 * dpr, panelY + panelHeight - 8 * dpr);
  }
  ctx.restore();
}

/* ─── Countdown Overlay ────────────────────────────────────────────────── */
function drawCountdown(ctx, W, H, seconds) {
  var dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.fillStyle = 'rgba(10, 13, 20, 0.5)';
  ctx.fillRect(0, 0, W, H);

  var text = seconds <= 0 ? '¡GO!' : String(seconds);
  var color = seconds <= 0 ? '#00f5d4' : seconds === 1 ? '#f72585' : '#ffb703';

  ctx.fillStyle = color;
  ctx.font = 'bold ' + (120 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 30;
  ctx.fillText(text, W / 2, H / 2);
  ctx.shadowBlur = 0;
  ctx.restore();
}

/* ─── Results Overlay ──────────────────────────────────────────────────── */
function drawResults(ctx, W, H) {
  var dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.fillStyle = 'rgba(10, 13, 20, 0.85)';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold ' + (40 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🏆 RESULTADOS', W / 2, 80 * dpr);

  if (GR.results && GR.results.results) {
    var res = GR.results.results;
    for (var i = 0; i < res.length && i < 12; i++) {
      var r = res[i];
      var yPos = (140 + i * 40) * dpr;
      var placeColor = i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : '#ffffff88';

      ctx.fillStyle = placeColor;
      ctx.font = 'bold ' + (20 * dpr) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('P' + r.place + '  ' + r.name, W / 2, yPos);

      ctx.fillStyle = '#ffffffaa';
      ctx.font = (12 * dpr) + 'px sans-serif';
      var timeStr = (r.time / 1000).toFixed(1) + 's';
      ctx.fillText(timeStr + '  ·  ' + (r.points || 0) + ' pts', W / 2, yPos + 18 * dpr);
    }
    if (GR.results.standings && GR.results.standings.length) {
      var standingsY = (170 + Math.min(res.length, 8) * 40) * dpr;
      ctx.fillStyle = '#00f5d4';
      ctx.font = 'bold ' + (16 * dpr) + 'px sans-serif';
      ctx.fillText(GR.results.championshipFinished ? 'PODIO FINAL' : 'CLASIFICACIÓN', W / 2, standingsY);
      for (var s = 0; s < GR.results.standings.length && s < 5; s++) {
        var standing = GR.results.standings[s];
        ctx.fillStyle = s < 3 ? ['#ffd700', '#c0c0c0', '#cd7f32'][s] : '#ffffffaa';
        ctx.font = 'bold ' + (14 * dpr) + 'px sans-serif';
        ctx.fillText((s + 1) + '. ' + standing.name + ' — ' + standing.points + ' pts',
          W / 2, (standingsY + 24 + s * 22) * dpr);
      }
    }
  }

  ctx.restore();
}

/* ─── Waiting screen ───────────────────────────────────────────────────── */
function drawWaiting(ctx, W, H) {
  var dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#00f5d4';
  ctx.font = 'bold ' + (24 * dpr) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Cargando pista...', W / 2, H / 2);
}

/* ─── Utility ──────────────────────────────────────────────────────────── */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ─── Expose ───────────────────────────────────────────────────────────── */
window.GAME_RENDERER = {
  init:            init,
  stop:            stop,
  setTrack:        setTrack,
  setGameState:    setGameState,
  setCountdown:    setCountdown,
  setResults:      setResults,
  triggerPowerEffect: triggerPowerEffect,
  setArrival:        setArrival,
  getLocalCar:     getLocalCar,
  addFloatingText: addFloatingText,
};

})();
