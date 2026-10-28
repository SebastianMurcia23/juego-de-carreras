/**
 * client/js/fx/particles.js
 * Particle system for Road Rumble item effects.
 * Pool of 320+ sprite particles; zero allocations per frame.
 * Ports the reference kart-3d-reference.html emit/burst/ring system.
 *
 * Requires THREE.js to be loaded as window.THREE.
 * Usage:
 *   const FX = window.FX_PARTICLES;
 *   FX.init(scene);
 *   FX.burst(pos, 0xff7a1a, 22, 16, 0.7, 2.4, true);
 *   FX.ring(pos, 0xffa040, 16);
 *   FX.boom(pos);
 *   // In render loop:
 *   FX.update(dt);
 */
(function() {
'use strict';
if (typeof window === 'undefined' || !window.THREE) return;
var THREE = window.THREE;

var POOL_SIZE = 320;
var _scene    = null;
var _parts    = [];
var _pc       = 0;
var _rings    = [];
var _tex      = null;
var _ZERO     = new THREE.Vector3();

/* ── Radial sprite texture ─────────────────────────────────────────────── */
function _makeTex() {
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var x = c.getContext('2d');
  var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0,   'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  var t = new THREE.CanvasTexture(c);
  return t;
}

/* ── Init ──────────────────────────────────────────────────────────────── */
function init(scene) {
  _scene = scene;
  if (!_tex) _tex = _makeTex();
  for (var i = 0; i < POOL_SIZE; i++) {
    var mat  = new THREE.SpriteMaterial({ map: _tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    var spr  = new THREE.Sprite(mat);
    spr.visible = false;
    scene.add(spr);
    _parts.push({ s: spr, life: 0, max: 1, v: new THREE.Vector3(), sz: 1, gr: 0, g: 0 });
  }
}

/* ── Emit one particle ────────────────────────────────────────────────── */
function emit(pos, vel, color, life, size, grow, additive, grav) {
  var p = _parts[_pc++ % POOL_SIZE];
  p.life = p.max = life;
  p.s.position.copy(pos);
  p.v.copy(vel);
  p.s.material.color.set(color);
  p.s.material.blending = (additive === false) ? THREE.NormalBlending : THREE.AdditiveBlending;
  p.sz = size;
  p.gr = grow || 0;
  p.g  = grav || 0;
  p.s.visible = true;
}

/* ── Update all particles ─────────────────────────────────────────────── */
function update(dt) {
  for (var i = 0; i < _parts.length; i++) {
    var p = _parts[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.s.visible = false; continue; }
    p.v.y -= p.g * dt;
    p.s.position.addScaledVector(p.v, dt);
    var a = p.life / p.max;
    p.s.material.opacity = Math.min(1, a * 1.4);
    var sz = p.sz * (1 + p.gr * (1 - a));
    p.s.scale.set(sz, sz, 1);
  }
  // rings
  for (var j = _rings.length - 1; j >= 0; j--) {
    var r = _rings[j];
    r.t += dt;
    var prog = r.t / 0.6;
    if (prog >= 1) {
      _scene.remove(r.m);
      r.m.geometry.dispose();
      r.m.material.dispose();
      _rings.splice(j, 1);
      continue;
    }
    var rs = 1 + prog * r.max;
    r.m.scale.set(rs, rs, 1);
    r.m.material.opacity = 1 - prog;
  }
}

/* ── Burst helper ─────────────────────────────────────────────────────── */
function burst(pos, color, n, speed, life, size, additive) {
  for (var i = 0; i < n; i++) {
    var v = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() * 0.9,
      Math.random() - 0.5
    ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
    emit(pos.clone().setY(pos.y + 1), v, color, life * (0.6 + Math.random() * 0.6), size, 1.4, additive, 9);
  }
}

/* ── Expanding ring ───────────────────────────────────────────────────── */
function ring(pos, color, maxScale) {
  if (!_scene) return;
  var geo = new THREE.RingGeometry(0.8, 1, 32);
  var mat = new THREE.MeshBasicMaterial({ color: color, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  var m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(pos.x, pos.y + 0.25, pos.z);
  _scene.add(m);
  _rings.push({ m: m, t: 0, max: maxScale || 14 });
}

/* ── Explosion ─────────────────────────────────────────────────────────── */
function boom(pos) {
  var p = pos.clone();
  p.y += 1;
  burst(p, 0xff7a1a, 22, 16, 0.7, 2.4, true);
  burst(p, 0xffe08a, 14, 22, 0.45, 1.4, true);
  burst(p, 0x555555, 12, 8, 1.1, 3, false);
  ring(pos, 0xffb040, 16);
}

/* ── Stars orbiting a point (for stun) ────────────────────────────────── */
var _stunStars = [];
function stunStarFrame(pos, T, n) {
  n = n || 3;
  for (var j = 0; j < n; j++) {
    var an = T * 10 + j * 2.1;
    var starPos = new THREE.Vector3(
      pos.x + Math.cos(an) * 1.2,
      pos.y + 2.8,
      pos.z + Math.sin(an) * 1.2
    );
    emit(starPos, _ZERO.clone(), 0xffe14a, 0.14, 0.8, 0, true, 0);
  }
}

/* ── Turbo flames ─────────────────────────────────────────────────────── */
function turboFlames(carGroup, fwdX, fwdZ, T) {
  // fwdX, fwdZ = forward direction of car
  var offsets = [[-0.55, 0.6], [0.55, 0.6]];
  for (var o = 0; o < offsets.length; o++) {
    var e = new THREE.Vector3(offsets[o][0], offsets[o][1], -1.9);
    if (carGroup && carGroup.localToWorld) carGroup.localToWorld(e);
    emit(e, new THREE.Vector3(-fwdX * 9 + (Math.random() - 0.5) * 2, Math.random() * 1.5, -fwdZ * 9 + (Math.random() - 0.5) * 2), 0xff8a20, 0.28, 1.5, 0.2, true, 0);
    emit(e, new THREE.Vector3(-fwdX * 14, Math.random(), -fwdZ * 14), 0x6fb4ff, 0.18, 0.8, 0, true, 0);
  }
}

/* ── Invincibility sparkles ────────────────────────────────────────────── */
function invSparkles(pos, T, i, bm) {
  var c = new THREE.Color().setHSL((T * 1.5 + i * 0.2) % 1, 0.9, 0.6);
  if (bm) { bm.color.copy(c); bm.emissive.copy(c).multiplyScalar(0.45); }
  emit(pos.clone().setY(pos.y + 1.2), _ZERO.clone(), c, 0.14, 5, 0, true, 0);
  if (Math.random() < 0.7) {
    var sp = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 0.5 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4));
    emit(sp, new THREE.Vector3(0, 3, 0), 0xffffcc, 0.5, 0.7, 0, true, 0);
  }
}

/* ── Box pickup burst ──────────────────────────────────────────────────── */
function boxPickup(pos) {
  burst(pos, 0xffd54a, 16, 12, 0.6, 1.2, true);
  burst(pos, 0x9fd0ff, 10, 9, 0.6, 1.0, true);
  ring(pos, 0xffd166, 10);
}

/* ── Export ────────────────────────────────────────────────────────────── */
window.FX_PARTICLES = {
  init:        init,
  emit:        emit,
  update:      update,
  burst:       burst,
  ring:        ring,
  boom:        boom,
  stunStarFrame: stunStarFrame,
  turboFlames: turboFlames,
  invSparkles: invSparkles,
  boxPickup:   boxPickup,
};
})();
