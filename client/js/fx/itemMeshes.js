/**
 * client/js/fx/itemMeshes.js
 * 3D mesh constructors for Road Rumble item objects.
 * Ports mkDisc, mkMissile, mkOil, box meshes from kart-3d-reference.html.
 *
 * Requires THREE.js (window.THREE).
 * Usage:
 *   const M = window.ITEM_MESHES;
 *   const disc = M.makeDisc();
 *   const missile = M.makeMissile();
 *   const oil = M.makeOil();
 *   const box = M.makeBox(); // rainbow item box with "?"
 */
(function() {
'use strict';
if (typeof window === 'undefined' || !window.THREE) return;
var THREE = window.THREE;

/* ── Rainbow "?" texture for item boxes ────────────────────────────────── */
var _qTex = null;
function _getQTex() {
  if (_qTex) return _qTex;
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#3a3a55';
  x.font = 'bold 46px sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('?', 32, 35);
  _qTex = new THREE.CanvasTexture(c);
  return _qTex;
}

/* ── Disc (bouncing green disc) ─────────────────────────────────────────── */
function makeDisc() {
  var g = new THREE.Group();
  var body = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 14, 10),
    new THREE.MeshLambertMaterial({ color: 0x2fbf71 })
  );
  body.scale.y = 0.55;
  var torus = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.18, 8, 18),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  torus.rotation.x = Math.PI / 2;
  g.add(body, torus);
  g.traverse(function(o) { o.castShadow = true; });
  return g;
}

/* ── Missile (red homing missile) ───────────────────────────────────────── */
function makeMissile() {
  var g = new THREE.Group();
  var rm  = new THREE.MeshLambertMaterial({ color: 0xe24b4a });
  var wm  = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var bodGeo = new THREE.CylinderGeometry(0.35, 0.35, 2, 10);
  bodGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  var body = new THREE.Mesh(bodGeo, rm);
  var nosGeo = new THREE.ConeGeometry(0.35, 0.9, 10);
  nosGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  var nose = new THREE.Mesh(nosGeo, wm);
  nose.position.z = 1.4;
  g.add(body, nose);
  for (var i = 0; i < 3; i++) {
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.6), wm);
    fin.position.z = -0.9;
    fin.rotation.z = i * 2.094;
    fin.translateY(0.45);
    g.add(fin);
  }
  g.traverse(function(o) { o.castShadow = true; });
  return g;
}

/* ── Oil slick ──────────────────────────────────────────────────────────── */
function makeOil() {
  var g = new THREE.Group();
  var pool = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.4, 0.06, 22),
    new THREE.MeshLambertMaterial({ color: 0x101018 })
  );
  var shine = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 0.08, 16),
    new THREE.MeshLambertMaterial({ color: 0x2c2c44 })
  );
  shine.position.set(0.5, 0.01, -0.3);
  g.add(pool, shine);
  return g;
}

/* ── Item box ────────────────────────────────────────────────────────────── */
var _boxMat = null;
function _getBoxMat() {
  if (_boxMat) return _boxMat;
  _boxMat = new THREE.MeshLambertMaterial({
    map: _getQTex(),
    transparent: true,
    opacity: 0.92,
    emissive: 0x222222,
  });
  return _boxMat;
}

function makeBox() {
  var box = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 1.9), _getBoxMat());
  box.castShadow = true;
  return box;
}

/** Animate box color (rainbow cycle). Call each frame with T = elapsed secs. */
function animateBoxMat(T) {
  var mat = _getBoxMat();
  if (mat && mat.color) mat.color.setHSL((T * 0.3) % 1, 0.7, 0.75);
}

/* ── Export ────────────────────────────────────────────────────────────── */
window.ITEM_MESHES = {
  makeDisc:      makeDisc,
  makeMissile:   makeMissile,
  makeOil:       makeOil,
  makeBox:       makeBox,
  animateBoxMat: animateBoxMat,
};
})();
