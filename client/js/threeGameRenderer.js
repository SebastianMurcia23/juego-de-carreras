/* Procedural WebGL race view. Uses the existing authoritative snapshots. */
(function() {
  'use strict';
  var canvasRendererFallback = window.GAME_RENDERER;
  if (!window.THREE) {
    console.warn('[3D] Three.js unavailable; keeping Canvas renderer');
    return;
  }
  var ARCADE = (window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);

  var R = {
    canvas: null, glCanvas: null, hud: null, renderer: null, scene: null,
    camera: null, track: null, state: null, seat: null, cars: {},
    projectiles: [], running: false, countdownEnd: 0, results: null,
    roadGroup: null, carGroup: null, projectileGroup: null, powerEffectGroup: null,
    powerEffects: [], pickupMeshes: [],
    // Arcade item meshes
    itemBoxMeshes: {},   // id → THREE.Mesh
    discMeshes: {},      // id → THREE.Group
    missileMeshes: {},   // id → THREE.Group
    oilMeshes: {},       // id → THREE.Group
    // Camera smoothing state
    _camPos: null, _camLook: null,
    // FPS / adaptive quality
    _frameTimes: [], _lowFpsTime: 0, _qualityTier: 2, // 0=low,1=mid,2=high
    // Time
    T: 0,
    // Ink overlay
    _inkEl: null, _inkBlobs: [],
    // Shake
    _shake: 0, _fov: 62,
    // Stun flags per car
    _stunPrev: {},
    composer: null, audio: null, fallbackMode: false,
    // sun reference for dynamic follow
    sun: null,
    // clouds reference for drifting animation
    clouds: [],
    _cloudMinX: -4000,
    _cloudMaxX: 4000,
  };

  function init(canvasId, seat) {
    R.seat = seat;
    R.canvas = document.getElementById(canvasId);
    if (!R.canvas) return;

    if (R.renderer && R.glCanvas && R.glCanvas.parentNode && R.scene) {
      R.running = true;
      R.fallbackMode = false;
      R.canvas.style.visibility = 'hidden';
      resize();
      return;
    }

    R.running = false;
    R.fallbackMode = false;
    if (R.glCanvas && R.glCanvas.parentNode) R.glCanvas.parentNode.removeChild(R.glCanvas);
    if (R.hud && R.hud.parentNode) R.hud.parentNode.removeChild(R.hud);
    try {
      R.glCanvas = document.createElement('canvas');
      R.glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:none;';
      R.canvas.parentNode.insertBefore(R.glCanvas, R.canvas);
      R.hud = document.createElement('canvas');
      R.hud.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;';
      R.canvas.parentNode.appendChild(R.hud);

      // Ink overlay (ARCADE mode)
      if (ARCADE) _initInkOverlay();

      R.renderer = new THREE.WebGLRenderer({ canvas: R.glCanvas, antialias: true });
      R.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      R.renderer.shadowMap.enabled = true;
      R.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      R.scene = new THREE.Scene();
      if (ARCADE) {
        R.scene.background = new THREE.Color(0x9fd3f5);
        R.scene.fog = new THREE.Fog(0x9fd3f5, 1200, 6000);
      } else {
        R.scene.background = new THREE.Color('#8ba9b2');
        R.scene.fog = new THREE.Fog('#8ba9b2', 500, 3000);
      }
      R.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 8000);
      R.roadGroup = new THREE.Group();
      R.carGroup = new THREE.Group();
      R.projectileGroup = new THREE.Group();
      R.powerEffectGroup = new THREE.Group();
      R.scene.add(R.roadGroup, R.carGroup, R.projectileGroup, R.powerEffectGroup);

      if (ARCADE) {
        R.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b8f4e, 0.9));
        var sun = new THREE.DirectionalLight(0xffffff, 0.85);
        sun.position.set(-300, 600, 250);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        var shc = sun.shadow.camera;
        shc.left   = -500;
        shc.right  =  500;
        shc.top    =  500;
        shc.bottom = -500;
        shc.near   =  10;
        shc.far    =  3500;
        R.scene.add(sun);
        R.scene.add(sun.target);
        R.sun = sun;
      } else {
        R.scene.add(new THREE.HemisphereLight('#d9f3ff', '#29422c', 1.8));
        var sun = new THREE.DirectionalLight('#fff0d0', 2.2);
        sun.position.set(-300, 500, 250);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        R.scene.add(sun);
        R.sun = sun;
      }

      // Camera smoothing state
      R._camPos  = new THREE.Vector3();
      R._camLook = new THREE.Vector3();
      R._shake   = 0;
      R._fov     = 62;
      R.T = 0;

      // Initialize particle system
      if (window.FX_PARTICLES) window.FX_PARTICLES.init(R.scene);

      if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass) {
        try {
          R.composer = new THREE.EffectComposer(R.renderer);
          R.composer.addPass(new THREE.RenderPass(R.scene, R.camera));
          R.composer.addPass(new THREE.UnrealBloomPass(
            new THREE.Vector2(R.canvas.clientWidth || 1280, R.canvas.clientHeight || 720),
            0.16, 0.35, 0.86
          ));
        } catch (postprocessError) {
          console.warn('[3D] Postprocess unavailable:', postprocessError);
          R.composer = null;
        }
      }
      try { setupEngineAudio(); } catch (e) { R.audio = null; }
      window.addEventListener('pointerdown', startEngineAudio, { once: true });
      window.addEventListener('resize', resize);
      resize();
      R.canvas.style.visibility = 'hidden';
      R.running = true;
      R._lastFrameTime = performance.now();
      requestAnimationFrame(loop);
    } catch (error) {
      console.error('[3D] renderer unavailable, using Canvas fallback:', error);
      R.running = false;
      R.fallbackMode = true;
      R.canvas.style.visibility = 'visible';
      if (R.glCanvas && R.glCanvas.parentNode) R.glCanvas.parentNode.removeChild(R.glCanvas);
      if (R.hud && R.hud.parentNode) R.hud.parentNode.removeChild(R.hud);
      if (canvasRendererFallback) canvasRendererFallback.init(canvasId, seat);
    }
  }

  function resize() {
    if (!R.renderer || !R.canvas) return;
    var w = R.canvas.clientWidth || innerWidth;
    var h = R.canvas.clientHeight || innerHeight;
    R.renderer.setSize(w, h, false);
    if (R.composer) R.composer.setSize(w, h);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    if (R.hud) { R.hud.width = Math.floor(w * devicePixelRatio); R.hud.height = Math.floor(h * devicePixelRatio); }
  }

  function makeCheckerboardTexture() {
    var c = document.createElement('canvas');
    c.width = 128;
    c.height = 32;
    var ctx = c.getContext('2d');
    for (var i = 0; i < 16; i++) {
      for (var j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#ffffff' : '#111111';
        ctx.fillRect(i * 8, j * 8, 8, 8);
      }
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function buildArcadeTrack(track) {
    var cps = track.checkpoints;
    if (!cps || cps.length < 3) return;

    R.scene.background = new THREE.Color(0x9fd3f5);
    if (R.scene.fog) {
      R.scene.fog.color.set(0x9fd3f5);
      R.scene.fog.near = 1200;
      R.scene.fog.far = 6000;
    }

    var P = cps.map(function(p) { return new THREE.Vector3(p.x, 0, -p.y); });
    var curve = new THREE.CatmullRomCurve3(P, true, 'catmullrom', 0.5);
    var LEN = curve.getLength();
    var N = Math.max(300, Math.min(800, Math.floor(LEN / 15)));

    var pts = [], rts = [];
    for (var i = 0; i <= N; i++) {
      var t = (i / N) % 1;
      pts.push(curve.getPointAt(t));
      var tg = curve.getTangentAt(t);
      rts.push(new THREE.Vector3(-tg.z, 0, tg.x).normalize());
    }

    function ribbon(o1, o2, y, cf) {
      var pos = [], col = [], idx = [];
      for (var i = 0; i <= N; i++) {
        var p = pts[i], r = rts[i], c = cf(i);
        pos.push(p.x + r.x * o1, y, p.z + r.z * o1, p.x + r.x * o2, y, p.z + r.z * o2);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      for (var i = 0; i < N; i++) {
        var a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      var m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.receiveShadow = true;
      R.roadGroup.add(m);
      return m;
    }

    var asph  = new THREE.Color(0x3b3d42);
    var asph2 = new THREE.Color(0x44464c);
    var red   = new THREE.Color(0xe24b4a);
    var white = new THREE.Color(0xffffff);

    var HW = track.roadHalfWidth || 92;
    var curbW = 14;

    // 1. Asphalt road (alternating shades matching reference)
    ribbon(-HW, HW, 0.05, function(i) { return Math.floor(i / 5) % 2 ? asph : asph2; });

    // 2. Right kerb / piano (alternating red/white)
    ribbon(HW, HW + curbW, 0.08, function(i) { return Math.floor(i / 3) % 2 ? red : white; });

    // 3. Left kerb / piano (alternating white/red)
    ribbon(-HW - curbW, -HW, 0.08, function(i) { return Math.floor(i / 3) % 2 ? white : red; });

    // 4. Center dashed line
    ribbon(-2.5, 2.5, 0.10, function(i) { return Math.floor(i / 4) % 2 ? white : asph; });

    // Start / Finish Line Arch (identical to kart-3d-reference.html)
    var chkTex = makeCheckerboardTexture();
    var t0 = curve.getTangentAt(0);
    var arch = new THREE.Group();
    arch.position.copy(pts[0]);
    arch.rotation.y = Math.atan2(t0.x, t0.z);

    // Floor checkered stripe
    var stripe = new THREE.Mesh(
      new THREE.PlaneGeometry((HW + curbW) * 2, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: chkTex })
    );
    stripe.position.y = 0.12;
    arch.add(stripe);

    // Dark side pillars
    var dkMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    var postOffset = HW + curbW + 16;
    [-1, 1].forEach(function(side) {
      var post = new THREE.Mesh(new THREE.BoxGeometry(8, 85, 8), dkMat);
      post.position.set(side * postOffset, 42.5, 0);
      post.castShadow = true;
      arch.add(post);
    });

    // Overhead checkered banner bar
    var bar = new THREE.Mesh(
      new THREE.BoxGeometry(postOffset * 2 + 10, 18, 8),
      new THREE.MeshBasicMaterial({ map: chkTex })
    );
    bar.position.y = 85;
    arch.add(bar);
    R.roadGroup.add(arch);

    // Track bounding box for environment scaling
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i <= N; i++) {
      var p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    var centerX = (minX + maxX) / 2;
    var centerZ = (minZ + maxZ) / 2;
    var spanX = maxX - minX;
    var spanZ = maxZ - minZ;
    var maxSpan = Math.max(spanX, spanZ, 2500);

    // Grass ground (exact green #5fa84a from reference)
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(maxSpan * 4, maxSpan * 4),
      new THREE.MeshLambertMaterial({ color: 0x5fa84a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(centerX, -0.22, centerZ);
    ground.receiveShadow = true;
    R.roadGroup.add(ground);

    // Trees (scattered around terrain, safely outside track)
    var trunkG = new THREE.CylinderGeometry(5, 7, 30, 6);
    var leafG  = new THREE.ConeGeometry(28, 60, 7);
    var trunkM = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    var leafM  = new THREE.MeshLambertMaterial({ color: 0x2f7d3a });
    var leafM2 = new THREE.MeshLambertMaterial({ color: 0x3e9a45 });
    var treeSpread = maxSpan * 1.5;
    var safeDistSq = (HW + curbW + 40) * (HW + curbW + 40);

    for (var k = 0; k < 120; k++) {
      var tx = centerX + (Math.random() - 0.5) * treeSpread;
      var tz = centerZ + (Math.random() - 0.5) * treeSpread;
      var ok = true;
      for (var i = 0; i <= N; i += 6) {
        var p = pts[i];
        var dx = p.x - tx, dz = p.z - tz;
        if (dx * dx + dz * dz < safeDistSq) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      var treeG = new THREE.Group();
      var tr = new THREE.Mesh(trunkG, trunkM);
      var lf = new THREE.Mesh(leafG, Math.random() < 0.5 ? leafM : leafM2);
      tr.position.y = 15;
      lf.position.y = 58;
      tr.castShadow = true;
      lf.castShadow = true;
      treeG.add(tr, lf);
      var sc = 0.8 + Math.random() * 0.9;
      treeG.scale.set(sc, sc, sc);
      treeG.position.set(tx, 0, tz);
      R.roadGroup.add(treeG);
    }

    // Mountains on horizon
    var mtnRadius = maxSpan * 1.6;
    for (var m = 0; m < 14; m++) {
      var a = (m / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      var mtn = new THREE.Mesh(
        new THREE.ConeGeometry(300 + Math.random() * 200, 450 + Math.random() * 300, 6),
        new THREE.MeshLambertMaterial({ color: 0x7e9aa8 })
      );
      mtn.position.set(
        centerX + Math.cos(a) * mtnRadius,
        160,
        centerZ + Math.sin(a) * mtnRadius
      );
      R.roadGroup.add(mtn);
    }

    // Drifting Clouds
    R.clouds = [];
    var cloudSpan = maxSpan * 2.2;
    R._cloudMinX = centerX - cloudSpan * 0.55;
    R._cloudMaxX = centerX + cloudSpan * 0.55;

    for (var c = 0; c < 10; c++) {
      var cloudG = new THREE.Group();
      var cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
      for (var j = 0; j < 3; j++) {
        var sph = new THREE.Mesh(new THREE.SphereGeometry(65 + Math.random() * 35, 10, 8), cloudMat);
        sph.position.set(j * 80 - 80, Math.random() * 25, Math.random() * 30);
        cloudG.add(sph);
      }
      cloudG.position.set(
        centerX + (Math.random() - 0.5) * cloudSpan,
        550 + Math.random() * 300,
        centerZ + (Math.random() - 0.5) * cloudSpan
      );
      R.roadGroup.add(cloudG);
      R.clouds.push(cloudG);
    }
  }

  function buildClassicTrack(track) {
    var theme = track.theme || 'classic';
    var themeStyle = getThemeStyle(theme);
    R.scene.background = new THREE.Color(themeStyle.sky);
    R.scene.fog.color.set(themeStyle.sky);
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshLambertMaterial({ color: themeStyle.ground })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.22;
    ground.receiveShadow = true;
    R.roadGroup.add(ground);
    var cps = track.checkpoints;
    var asphalt = makeAsphaltMaterial();
    var roadWidth = (track.roadHalfWidth || 92) * 2;
    for (var i = 0; i < cps.length; i++) {
      var a = cps[i], b = cps[(i + 1) % cps.length];
      var dx = b.x - a.x, dz = -(b.y - a.y);
      var len = Math.max(1, Math.sqrt(dx * dx + dz * dz));
      var road = new THREE.Mesh(
        new THREE.BoxGeometry(roadWidth, 0.18, len + 2),
        a.terrain === 'asphalt' ? asphalt : new THREE.MeshLambertMaterial({ color: terrainColor(a.terrain) })
      );
      road.position.set((a.x + b.x) / 2, 0.04, -(a.y + b.y) / 2);
      road.rotation.y = Math.atan2(dx, dz);
      road.receiveShadow = true;
      R.roadGroup.add(road);
      var edge = new THREE.Mesh(
        new THREE.BoxGeometry(roadWidth + 10, 0.12, len + 2),
        new THREE.MeshLambertMaterial({ color: '#d8c987' })
      );
      edge.position.copy(road.position);
      edge.position.y = -0.02;
      edge.rotation.y = road.rotation.y;
      R.roadGroup.add(edge);

      [-1, 1].forEach(function(side) {
        var curb = new THREE.Mesh(
          new THREE.BoxGeometry(11, 0.2, Math.min(len * 0.9, 72)),
          new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? '#e63946' : '#f1f1f1' })
        );
        curb.position.set(
          road.position.x + Math.cos(road.rotation.y) * side * (roadWidth / 2 + 5),
          0.18,
          road.position.z - Math.sin(road.rotation.y) * side * (roadWidth / 2 + 5)
        );
        curb.rotation.y = road.rotation.y;
        R.roadGroup.add(curb);
      });

      var stripe = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 0.03, Math.min(len * 0.42, 34)),
        new THREE.MeshLambertMaterial({ color: '#f5e6a8' })
      );
      stripe.position.copy(road.position);
      stripe.position.y = 0.16;
      stripe.rotation.y = road.rotation.y;
      R.roadGroup.add(stripe);

      var laneCount = track.laneCount || 4;
      for (var lane = 1; lane < laneCount; lane++) {
        var laneOffset = (lane / laneCount - 0.5) * roadWidth;
        var laneMark = new THREE.Mesh(
          new THREE.BoxGeometry(1.4, 0.025, Math.min(len * 0.52, 42)),
          new THREE.MeshLambertMaterial({ color: '#ffffffaa' })
        );
        laneMark.position.set(
          road.position.x + Math.cos(road.rotation.y) * laneOffset,
          0.17,
          road.position.z - Math.sin(road.rotation.y) * laneOffset
        );
        laneMark.rotation.y = road.rotation.y;
        R.roadGroup.add(laneMark);
      }
    }
    addStartFinishLine(track, roadWidth);
    addPickupBoxes(track);
  }

  function adjustSceneForTrack(track) {
    if (!track || !R.scene || !R.camera) return;
    var b = track.bounds || { minX: -1500, maxX: 1500, minY: -1500, maxY: 1500 };
    var spanX = Math.max(1000, b.maxX - b.minX);
    var spanY = Math.max(1000, b.maxY - b.minY);
    var maxSpan = Math.max(spanX, spanY);

    R.camera.near = 0.5;
    R.camera.far = Math.max(12000, maxSpan * 3.5);
    R.camera.updateProjectionMatrix();

    if (R.scene.fog) {
      R.scene.fog.near = Math.max(1500, maxSpan * 0.4);
      R.scene.fog.far  = Math.max(7000, maxSpan * 2.2);
    }

    if (R.sun && R.sun.shadow && R.sun.shadow.camera) {
      var shc = R.sun.shadow.camera;
      var halfSpan = Math.max(700, maxSpan * 0.45);
      shc.left   = -halfSpan;
      shc.right  =  halfSpan;
      shc.top    =  halfSpan;
      shc.bottom = -halfSpan;
      shc.near   =  10;
      shc.far    =  Math.max(4000, maxSpan * 2);
      shc.updateProjectionMatrix();
    }

    var startCp = track.checkpoints && track.checkpoints[0];
    var nextCp = track.checkpoints && track.checkpoints[1];
    if (startCp) {
      var dx = nextCp ? nextCp.x - startCp.x : 100;
      var dy = nextCp ? nextCp.y - startCp.y : 0;
      var ang = Math.atan2(-dy, dx);
      if (!R._camPos) R._camPos = new THREE.Vector3();
      if (!R._camLook) R._camLook = new THREE.Vector3();
      R._camPos.set(startCp.x - Math.cos(ang) * 90, 45, -startCp.y - Math.sin(ang) * 90);
      R._camLook.set(startCp.x, 10, -startCp.y);
    }
  }

  function resetForNewRace(track) {
    if (R.fallbackMode && canvasRendererFallback) {
      if (canvasRendererFallback.resetForNewRace) canvasRendererFallback.resetForNewRace(track);
      else canvasRendererFallback.setTrack(track);
      return;
    }
    if (!track) return;
    R.track = track;

    // 1. Safely dispose previous track meshes
    if (window.ITEM_MESHES && window.ITEM_MESHES.resetMaterials) {
      window.ITEM_MESHES.resetMaterials();
    }
    clearGroup(R.roadGroup);
    clearGroup(R.projectileGroup);
    clearGroup(R.powerEffectGroup);
    clearGroup(R.carGroup);

    // 2. Clear particles
    if (window.FX_PARTICLES && window.FX_PARTICLES.clear) {
      window.FX_PARTICLES.clear();
    }

    // 3. Reset maps and caches
    R.cars = {};
    R.itemBoxMeshes = {};
    R.discMeshes = {};
    R.missileMeshes = {};
    R.oilMeshes = {};
    R.projectiles = [];
    R.powerEffects = [];
    R.pickupMeshes = [];
    R.clouds = [];
    R.arrivals = [];
    R._stunPrev = {};
    R.state = null;

    // 4. Build track
    if (ARCADE) {
      buildArcadeTrack(track);
    } else {
      buildClassicTrack(track);
    }

    // 5. Adjust scene frustum, fog, shadows
    adjustSceneForTrack(track);

    // 6. Reset interpolation
    R._camPos = null;
    R._camLook = null;
    R.stateReceivedAt = performance.now();
    R._lastFrameTime = performance.now();
    R.T = 0;
    R._shake = 0;
  }

  function setTrack(track) {
    resetForNewRace(track);
  }

  function getThemeStyle(theme) {
    var styles = {
      desert: { sky: '#d6a77a', ground: '#8a7547', accent: '#e6b35a' },
      urban: { sky: '#71879a', ground: '#3e4b54', accent: '#f72585' },
      forest: { sky: '#789b9a', ground: '#385b3d', accent: '#e9c46a' },
      coastal: { sky: '#72b7c8', ground: '#c3b879', accent: '#00b4d8' },
      classic: { sky: '#8ba9b2', ground: '#496b43', accent: '#e63946' },
    };
    return styles[theme] || styles.classic;
  }

  function addPickupBoxes(track) {
    (track.pickups || []).forEach(function(pickup, index) {
      var box = new THREE.Mesh(
        new THREE.BoxGeometry(14, 14, 14),
        new THREE.MeshPhongMaterial({ color: '#9b5de5', emissive: '#3b1768', shininess: 90 })
      );
      box.position.set(pickup.x, 10, -pickup.y);
      box.userData.pickupIndex = index;
      box.rotation.y = Math.PI / 4;
      box.castShadow = true;
      R.roadGroup.add(box);
      R.pickupMeshes.push({ box: box, baseY: 10, phase: index * 1.7 });
      var mark = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 8),
        new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide })
      );
      mark.position.set(pickup.x, 10, -pickup.y - 7.1);
      mark.rotation.x = -Math.PI / 2;
      R.roadGroup.add(mark);
    });
  }

  function addStartFinishLine(track, roadWidth) {
    var start = track.checkpoints && track.checkpoints[0];
    var next = track.checkpoints && track.checkpoints[1];
    if (!start || !next) return;
    var dx = next.x - start.x;
    var dz = -(next.y - start.y);
    var line = new THREE.Mesh(
      new THREE.BoxGeometry(roadWidth, 0.28, 7),
      new THREE.MeshLambertMaterial({ color: '#f72585' })
    );
    line.position.set(start.x, 0.24, -start.y);
    line.rotation.y = Math.atan2(dx, dz);
    line.receiveShadow = true;
    R.roadGroup.add(line);
  }

  function makeAsphaltMaterial() {
    var textureCanvas = document.createElement('canvas');
    textureCanvas.width = 256;
    textureCanvas.height = 256;
    var textureContext = textureCanvas.getContext('2d');
    textureContext.fillStyle = '#30343b';
    textureContext.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 1800; i++) {
      var shade = 28 + Math.floor(Math.random() * 28);
      textureContext.fillStyle = 'rgb(' + shade + ',' + shade + ',' + (shade + 4) + ')';
      textureContext.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
    }
    var texture = new THREE.CanvasTexture(textureCanvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 8);
    return new THREE.MeshStandardMaterial({ color: '#62666b', map: texture, roughness: 0.92, metalness: 0.02 });
  }

  function setGameState(state) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setGameState(state); return; }
    R.state = state;
    R.stateReceivedAt = performance.now();
  }
  function setCountdown(seconds) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setCountdown(seconds); return; }
    R.countdownEnd = Date.now() + seconds * 1000;
    // When countdown starts for a new race, clear results overlay and intermission
    R.results = null;
    R.intermission = null;
  }
  function setResults(results) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setResults(results); return; }
    R.results = Array.isArray(results) ? { results: results } : results;
    if (R.results && R.results.intermissionSeconds) {
      R.intermissionEnd = Date.now() + R.results.intermissionSeconds * 1000;
    }
  }
  function setIntermission(data) {
    if (R.fallbackMode && canvasRendererFallback) {
      if (canvasRendererFallback.setIntermission) canvasRendererFallback.setIntermission(data);
      return;
    }
    R.intermission = data;
    R.intermissionEnd = Date.now() + (data.seconds || 12) * 1000;
    if (data.results || data.standings) {
      R.results = data;
    }
  }
  function stop() {
    R.running = false;
    if (R.fallbackMode && canvasRendererFallback) canvasRendererFallback.stop();
  }

  function loop() {
    if (!R.running) return;
    requestAnimationFrame(loop);
    var now = performance.now();
    var dt = Math.min(0.05, (now - (R._lastFrameTime || now)) / 1000);
    R._lastFrameTime = now;
    R.T += dt;

    updateCars(dt);
    if (ARCADE) {
      updateItemBoxes();
      updateItemProjectiles();
      if (R.clouds && R.clouds.length) {
        var minX = R._cloudMinX || -4000;
        var maxX = R._cloudMaxX || 4000;
        for (var ci = 0; ci < R.clouds.length; ci++) {
          var cl = R.clouds[ci];
          cl.position.x += dt * 30;
          if (cl.position.x > maxX) cl.position.x = minX;
        }
      }
    } else {
      updateProjectiles();
    }
    updatePowerEffects();
    updatePickupAnimations();
    if (window.FX_PARTICLES) window.FX_PARTICLES.update(dt);
    updateAdaptiveQuality(dt);
    drawHud();
    if (R.composer) R.composer.render();
    else R.renderer.render(R.scene, R.camera);
  }

  /* ── Adaptive quality ──────────────────────────────────────────────────── */
  function updateAdaptiveQuality(dt) {
    R._frameTimes.push(dt);
    if (R._frameTimes.length > 60) R._frameTimes.shift();
    if (R._frameTimes.length < 60) return;
    var avgFps = 1 / (R._frameTimes.reduce(function(a,b){return a+b;},0)/R._frameTimes.length);
    if (avgFps < 50) {
      R._lowFpsTime += dt;
      if (R._lowFpsTime > 2 && R._qualityTier > 0) {
        R._qualityTier--;
        R._lowFpsTime = 0;
        if (R._qualityTier === 1) { R.renderer.shadowMap.enabled = false; }
        if (R._qualityTier === 0) { R.renderer.setPixelRatio(1); }
      }
    } else {
      R._lowFpsTime = 0;
    }
  }

  /* ── Ink overlay (ARCADE) ──────────────────────────────────────────────── */
  function _initInkOverlay() {
    var inkEl = document.createElement('div');
    inkEl.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;opacity:0;transition:opacity .5s;z-index:10;';
    R._inkEl = inkEl;
    R._inkBlobs = [];
    for (var i = 0; i < 7; i++) {
      var d = document.createElement('div');
      var s = 90 + Math.random() * 90;
      d.style.cssText = 'position:absolute;border-radius:50%;background:rgba(15,15,25,.94);width:'+s+'px;height:'+s+'px;left:'+(Math.random()*85)+'%;top:'+(Math.random()*85)+'%;transform:scale(0);transition:transform '+(.25+Math.random()*.2)+'s ease-out';
      inkEl.appendChild(d);
      R._inkBlobs.push(d);
    }
    if (R.canvas && R.canvas.parentNode) R.canvas.parentNode.appendChild(inkEl);
  }

  function showInk() {
    if (!R._inkEl) return;
    R._inkEl.style.opacity = 1;
    R._inkBlobs.forEach(function(b) { b.style.transform = 'scale(1.6)'; });
    setTimeout(function() {
      R._inkEl.style.opacity = 0;
      setTimeout(function() { R._inkBlobs.forEach(function(b) { b.style.transform = 'scale(0)'; }); }, 600);
    }, 2600);
  }

  /* ── Missile warning viñeta ────────────────────────────────────────────── */
  var _missileWarnEnd = 0;
  /* ── Item Names & Icons ──────────────────────────────────────────────── */
  var ITEM_DATA = {
    turbo:          { name: 'Turbo', icon: '🔥', col: '#ff9e00' },
    disco:          { name: 'Disco rebotante', icon: '💿', col: '#06d6a0' },
    misil:          { name: 'Misil buscador', icon: '🚀', col: '#e63946' },
    aceite:         { name: 'Mancha de aceite', icon: '💧', col: '#495057' },
    estrella:       { name: 'Invencibilidad', icon: '⭐', col: '#ffd166' },
    invencibilidad: { name: 'Invencibilidad', icon: '⭐', col: '#ffd166' },
    tinta:          { name: 'Tinta', icon: '🖌️', col: '#212529' },
  };
  var ITEM_KEYS = ['turbo', 'disco', 'misil', 'aceite', 'invencibilidad', 'tinta'];

  /* ── Toasts & Warnings ─────────────────────────────────────────────────── */
  var _toastText = '';
  var _toastAlpha = 0;
  var _toastTimer = null;
  function showToast(text) {
    _toastText = text;
    _toastAlpha = 1;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() {
      var fade = setInterval(function() {
        _toastAlpha -= 0.08;
        if (_toastAlpha <= 0) {
          _toastAlpha = 0;
          clearInterval(fade);
        }
      }, 30);
    }, 1900);
  }

  var _missileWarnEnd = 0;
  function showMissileWarning() {
    _missileWarnEnd = Date.now() + 3500;
  }

  /* ── Arcade Item Socket Events Dispatcher ──────────────────────────────── */
  function handleItemEvent(event, data) {
    if (!data) return;
    var EV = (window.SHARED && window.SHARED.EVENTS) || {};
    var FX = window.FX_PARTICLES;

    if (event === EV.ITEM_BOX_TAKEN) {
      if (data.seatToken === R.seat) {
        var it = ITEM_DATA[data.item];
        showToast('Recibes: ' + (it ? it.name : data.item));
      }
      var carMesh = R.cars[data.seatToken];
      if (carMesh && FX && FX.boxPickup) {
        FX.boxPickup(carMesh.position);
      }
    } else if (event === EV.ITEM_ROLLING) {
      if (data.seatToken === R.seat) {
        showToast('Abriendo caja…');
      }
    } else if (event === EV.ITEM_USED) {
      var itName = ITEM_DATA[data.item] ? ITEM_DATA[data.item].name : data.item;
      if (data.seatToken === R.seat) {
        showToast('Tú usas ' + itName);
      } else {
        showToast('Rival usa ' + itName);
      }
      if (data.item === 'misil' && data.target === R.seat) {
        showMissileWarning();
        showToast('¡Misil buscador viene hacia ti!');
      }
    } else if (event === EV.ITEM_HIT) {
      var itHit = ITEM_DATA[data.item] ? ITEM_DATA[data.item].name : data.item;
      if (data.victim === R.seat) {
        showToast('¡Te golpeó ' + itHit + '!');
        R._shake = 1.2;
      }
    } else if (event === EV.ITEM_BLOCKED) {
      if (data.seatToken === R.seat) {
        showToast('¡Bloqueaste el golpe!');
        var myCar = R.cars[data.seatToken];
        if (myCar && FX && FX.ring) {
          FX.ring(myCar.position, 0xffd54a, 8);
        }
      }
    }
  }

  /* ── 3D Kart Model (identical to makeKart in kart-3d-reference.html) ────── */
  function makeKart(color) {
    var g = new THREE.Group();
    var m = new THREE.Group();
    g.add(m);

    var bm = new THREE.MeshLambertMaterial({ color: color });
    var drk = new THREE.MeshLambertMaterial({ color: 0x222222 });
    var skin = new THREE.MeshLambertMaterial({ color: 0xf2c9a0 });

    function add(geo, mat, x, y, z) {
      var o = new THREE.Mesh(geo, mat);
      o.position.set(x, y, z);
      o.castShadow = true;
      m.add(o);
      return o;
    }

    // Road Rumble standard: nose along local -Z
    add(new THREE.BoxGeometry(1.7, 0.55, 3), bm, 0, 0.7, 0);
    add(new THREE.BoxGeometry(1.1, 0.4, 1.3), bm, 0, 0.62, -1.9);
    add(new THREE.BoxGeometry(2.1, 0.12, 0.5), drk, 0, 0.5, -2.6);
    add(new THREE.BoxGeometry(2.0, 0.15, 0.5), bm, 0, 1.5, 1.6);
    add(new THREE.BoxGeometry(0.15, 0.7, 0.15), drk, -0.7, 1.15, 1.6);
    add(new THREE.BoxGeometry(0.15, 0.7, 0.15), drk, 0.7, 1.15, 1.6);
    add(new THREE.SphereGeometry(0.38, 10, 8), skin, 0, 1.2, -0.1);
    add(new THREE.SphereGeometry(0.46, 10, 8), bm, 0, 1.62, -0.05);

    var wg = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 14);
    wg.rotateZ(Math.PI / 2);
    var wheels = [];
    var frontWheels = [];
    [[-1, -1.2], [1, -1.2], [-1, 1.2], [1, 1.2]].forEach(function(a, idx) {
      var wh = add(wg, drk, a[0] * 1.05, 0.5, a[1]);
      wheels.push(wh);
      if (idx < 2) frontWheels.push(wh);
    });

    return { g: g, m: m, bm: bm, wheels: wheels, frontWheels: frontWheels };
  }

  /* ── Classic F1 Model Fallback (used when ARCADE_ITEMS=false) ───────────── */
  function makeClassicCar(data) {
    var g = new THREE.Group();
    var def = window.CONFIG && window.CONFIG.CARS
      ? window.CONFIG.CARS.find(function(car) { return car.id === data.cid; })
      : null;
    var color = new THREE.Color(def && def.color || data.clr || '#00f5d4');
    var accent = new THREE.Color(def && def.accentColor || '#ffffff');
    var length = (def && def.dimensions && def.dimensions.length) || 65;
    var width = (def && def.dimensions && def.dimensions.width) || 36;
    var variants = {
      apex_venom: [1.2, 0.85, 1.1, 0.8, 1],
      goliath_mk4: [0.9, 1.4, 1.2, 1.1, 1.15],
      drift_phantom: [1.1, 0.95, 1.3, 0.85, 1],
      mud_crusher: [0.9, 1.2, 0.9, 1.6, 1.35],
      viper_gt: [1, 1, 1, 1, 1],
      nitro_wasp: [1.15, 0.8, 1, 0.9, 0.95],
      iron_boar: [0.85, 1.3, 1.1, 1, 1.15],
      cyber_storm: [1.25, 0.9, 1.15, 0.8, 1],
      dune_raider: [0.9, 1.1, 1, 1.5, 1.3],
      titan_roller: [0.8, 1.5, 1.3, 1.3, 1.4],
    }[data.cid] || [1, 1, 1, 1, 1];
    var noseScale = variants[0], podScale = variants[1], wingScale = variants[2];
    var rideHeight = variants[3], tireScale = variants[4];
    function material(hex, roughness) { return new THREE.MeshPhongMaterial({ color: hex, shininess: roughness }); }
    var bodyMat = material(color, 100);
    var accentMat = material(accent, 80);
    var carbon = new THREE.MeshLambertMaterial({ color: '#1b1b1d' });
    var tireMat = new THREE.MeshLambertMaterial({ color: '#111111' });
    var rimMat = new THREE.MeshPhongMaterial({ color: '#9a9a9a', shininess: 70 });
    function box(size, position, mat) {
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    }
    box([26, 7, 42], [0, 8, 2], bodyMat);
    box([18, 5, 30 * podScale], [-2, 6, 1], bodyMat);
    box([10, 4, 20], [0, 6, -20], bodyMat);
    box([72, 2, 32], [0, 3, 2], carbon);
    box([12, 3, 32 * podScale], [-1, 8, 11], accentMat);
    var nose = new THREE.Mesh(new THREE.ConeGeometry(3.5, 34 * noseScale, 8), bodyMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 7 * rideHeight, -34 * noseScale - 4);
    nose.scale.set(0.9, 0.9, 1);
    nose.castShadow = true;
    g.add(nose);
    var cockpit = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 8), new THREE.MeshPhongMaterial({ color: '#07111e', shininess: 140 }));
    cockpit.scale.set(0.72, 0.7, 1.35);
    cockpit.position.set(0, 14 * rideHeight, 1);
    cockpit.castShadow = true;
    g.add(cockpit);
    var halo = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.55, 8, 18, Math.PI), carbon);
    halo.rotation.z = Math.PI / 2;
    halo.scale.x = 1.45;
    halo.position.set(0, 15 * rideHeight, 1);
    g.add(halo);
    box([58 * wingScale, 2, 8], [0, 4, -45], carbon);
    box([48 * wingScale, 2, 4], [0, 5, -45], accentMat);
    box([6, 5, 24], [0, 7, -34], carbon);
    box([52 * wingScale, 3, 6], [0, 17 * rideHeight, 31], carbon);
    box([44 * wingScale, 2, 4], [0, 19 * rideHeight, 31], accentMat);
    box([4, 10, 4], [0, 12 * rideHeight, 31], carbon);
    g.userData.frontWheels = [];
    for (var x = -1; x <= 1; x += 2) for (var z = -1; z <= 1; z += 2) {
      var rear = z > 0;
      var radius = (rear ? 8 : 7) * tireScale;
      var wheel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, rear ? 6 : 4.5, 16), tireMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x * Math.max(18, width * 0.52), 5 * rideHeight, rear ? 25 : -25);
      wheel.castShadow = true;
      g.add(wheel);
      var rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, (rear ? 6 : 4.5) + 0.02, 16), rimMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.copy(wheel.position);
      g.add(rim);
      if (z < 0) g.userData.frontWheels.push(wheel);
    }
    return g;
  }

  function makeCar(data) {
    var def = window.CONFIG && window.CONFIG.CARS
      ? window.CONFIG.CARS.find(function(car) { return car.id === data.cid; })
      : null;
    var colHex = def && def.color ? def.color : (data.clr || '#00f5d4');
    var color = new THREE.Color(colHex);
    var length = (def && def.dimensions && def.dimensions.length) || 65;
    var kD = length / 3;

    if (!ARCADE) {
      var classicG = makeClassicCar(data);
      classicG.userData.kD = kD;
      return classicG;
    }

    var kart = makeKart(color);
    var g = kart.g;
    g.userData.m = kart.m;
    g.userData.bm = kart.bm;
    g.userData.baseColor = color.clone();
    g.userData.wheels = kart.wheels;
    g.userData.frontWheels = kart.frontWheels;
    g.userData.kD = kD;
    kart.m.scale.set(kD, kD, kD);
    return g;
  }

  /* ── Update Cars (Animations & Camera) ─────────────────────────────────── */
  function updateCars(dt) {
    if (!R.state || !R.state.cars) return;
    var seen = {};
    var FX = window.FX_PARTICLES;

    for (var i = 0; i < R.state.cars.length; i++) {
      var data = R.state.cars[i];
      var group = R.cars[data.st];
      seen[data.st] = true;
      if (!group || group.parent !== R.carGroup) {
        if (group && group.parent) group.parent.remove(group);
        group = makeCar(data);
        R.cars[data.st] = group;
        R.carGroup.add(group);
        if (R._warnThrottleCars !== (data.st + '_' + (R.track ? R.track.id : ''))) {
          R._warnThrottleCars = data.st + '_' + (R.track ? R.track.id : '');
          console.warn('[3D Safeguard] Reconstructed/attached car mesh in scene for:', data.nm || data.st);
        }
      }
      var isLocal = (data.st === R.seat);
      var predictionSeconds = isLocal && R.stateReceivedAt
        ? Math.min(0.055, Math.max(0, (performance.now() - R.stateReceivedAt) / 1000))
        : 0;
      var predictedX = data.x + Math.cos(data.a) * (data.spd || 0) * predictionSeconds;
      var predictedY = data.y + Math.sin(data.a) * (data.spd || 0) * predictionSeconds;

      if (!group.userData.target) {
        group.position.set(predictedX, 3, -predictedY);
        group.userData.target = new THREE.Vector3(predictedX, 3, -predictedY);
      } else {
        group.userData.target.set(predictedX, 3, -predictedY);
        group.position.lerp(group.userData.target, isLocal ? 0.92 : 0.5);
      }

      group.rotation.y = data.a - Math.PI / 2;
      group.visible = Boolean(data.alive || data.fin);
      group.userData.speed = data.spd || 0;

      var kD = group.userData.kD || 21.67;
      var m = group.userData.m;

      if (m) {
        var steer = data.steerAngle || 0;
        // Lateral bank/lean
        m.rotation.z += ((-steer * 0.35) - m.rotation.z) * Math.min(1, dt * 8);

        // Wheel steer & rotation
        var wRot = (data.spd || 0) * dt / (0.5 * kD);
        if (group.userData.wheels) {
          group.userData.wheels.forEach(function(wh) { wh.rotation.x += wRot; });
        }
        if (group.userData.frontWheels) {
          group.userData.frontWheels.forEach(function(wh) { wh.rotation.y = steer; });
        }

        // Stun animation (spin 4*PI, hop jump, 3 orbiting stars)
        var isStunned = Boolean(data.stun || data.slowed);
        if (isStunned) {
          if (!group.userData.wasStunned) {
            group.userData.wasStunned = true;
            group.userData.stunTime = 0;
            if (FX && FX.boom) FX.boom(group.position);
            if (isLocal) {
              R._shake = 1.2;
              showToast('¡Te golpearon!');
            }
          }
          group.userData.stunTime = (group.userData.stunTime || 0) + dt;
          var pr = Math.min(1, group.userData.stunTime / 1.4);
          var spin = (1 - pr) * Math.PI * 4;
          var hop = Math.sin(pr * Math.PI) * 1.3 * kD;
          m.rotation.y = spin;
          m.position.y = hop;
          if (FX && FX.stunStarFrame) {
            FX.stunStarFrame(group.position, R.T, 3);
          }
        } else {
          if (group.userData.wasStunned) {
            group.userData.wasStunned = false;
            group.userData.stunTime = 0;
            m.rotation.y = 0;
          }
          var vib = Math.sin(R.T * 22 + i) * 0.025 * kD * ((data.spd || 0) > 0 ? 1 : 0);
          m.position.y = vib;
        }

        // Turbo boost flames & wind lines
        if (data.boost) {
          if (FX && FX.turboFlames) {
            FX.turboFlames(group, Math.cos(data.a), -Math.sin(data.a), R.T);
          }
          if (isLocal && FX && FX.emit) {
            var fwd = new THREE.Vector3(Math.cos(data.a), 0, -Math.sin(data.a));
            for (var sl = 0; sl < 2; sl++) {
              var origin = group.position.clone().add(new THREE.Vector3(
                fwd.x * 14 * kD + (Math.random() - 0.5) * 14 * kD,
                0.5 * kD + Math.random() * 4 * kD,
                fwd.z * 14 * kD + (Math.random() - 0.5) * 14 * kD
              ));
              FX.emit(origin, new THREE.Vector3(-fwd.x * 70 * kD, 0, -fwd.z * 70 * kD), 0xffffff, 0.3, 0.5 * kD, 0, true, 0);
            }
          }
        }

        // Invincibility rainbow cycling
        var bm = group.userData.bm;
        if (data.inv || data.star) {
          if (FX && FX.invSparkles) {
            FX.invSparkles(group.position, R.T, i, bm);
          }
        } else if (bm && group.userData.baseColor) {
          bm.color.copy(group.userData.baseColor);
          bm.emissive.setHex(0);
        }

        // Ink effect on local player
        if (isLocal && data.ink) {
          if (!group.userData.wasInked) {
            group.userData.wasInked = true;
            showInk();
            showToast('¡Te cayó tinta!');
          }
        } else if (isLocal) {
          group.userData.wasInked = false;
        }
      }
    }

    Object.keys(R.cars).forEach(function(key) {
      if (!seen[key]) R.cars[key].visible = false;
    });

    // Chase camera
    var local = getLocal();
    if (!local) return;
    updateEngineAudio(local.spd || 0, (local.spd || 0) > 20);

    var localGroup = R.cars[local.st];
    var lkD = (localGroup && localGroup.userData && localGroup.userData.kD) || 21.67;
    var heading = new THREE.Vector3(Math.cos(local.a), 0, -Math.sin(local.a));
    var isBoosting = Boolean(local.boost);
    var isInv = Boolean(local.inv || local.star);

    var distBehind = (10.5 + (isBoosting ? 2.5 : 0)) * lkD;
    var heightUp = 5.2 * lkD;
    var lookAhead = 7.0 * lkD;
    var lookHeight = 1.6 * lkD;

    var camDesired = new THREE.Vector3(local.x, heightUp, -local.y).addScaledVector(heading, -distBehind);
    var camTarget = new THREE.Vector3(local.x, lookHeight, -local.y).addScaledVector(heading, lookAhead);

    if (!R._camPos) {
      R._camPos = camDesired.clone();
      R._camLook = camTarget.clone();
    } else {
      R._camPos.lerp(camDesired, 1 - Math.exp(-dt * 5));
      R._camLook.lerp(camTarget, 1 - Math.exp(-dt * 9));
    }

    R._shake = Math.max((R._shake || 0) - dt * 2.5, isBoosting ? 0.25 : 0);
    var sh = (R._shake || 0) * 0.35 * lkD;
    R.camera.position.set(
      R._camPos.x + (Math.random() - 0.5) * sh,
      R._camPos.y + (Math.random() - 0.5) * sh,
      R._camPos.z + (Math.random() - 0.5) * sh
    );
    R.camera.lookAt(R._camLook);

    var targetFov = 62 + (isBoosting ? 20 : 0) + (isInv ? 8 : 0);
    R._fov = (R._fov || 62) + (targetFov - (R._fov || 62)) * Math.min(1, dt * 6);
    if (Math.abs(R.camera.fov - R._fov) > 0.01) {
      R.camera.fov = R._fov;
      R.camera.updateProjectionMatrix();
    }

    if (R.sun) {
      R.sun.position.set(local.x + 40 * lkD, 70 * lkD, -local.y + 30 * lkD);
      R.sun.target.position.set(local.x, 0, -local.y);
      if (R.sun.target.updateMatrixWorld) R.sun.target.updateMatrixWorld();
    }
  }

  function setupEngineAudio() {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    var context = new AudioCtor();
    var oscillator = context.createOscillator();
    var gain = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = 70;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    R.audio = { context: context, oscillator: oscillator, gain: gain };
  }

  function startEngineAudio() {
    if (R.audio && R.audio.context.state === 'suspended') R.audio.context.resume();
  }

  function updateEngineAudio(speed, accelerating) {
    if (!R.audio) return;
    var now = R.audio.context.currentTime;
    var ratio = Math.max(0, Math.min(1, speed / 450));
    R.audio.oscillator.frequency.setTargetAtTime(
      70 + ratio * 220 + (accelerating ? 35 : 0), now, 0.05
    );
    R.audio.gain.gain.setTargetAtTime(0.018 + ratio * 0.035, now, 0.08);
  }

  /* ── Update Item Boxes (Floating & Pop-in) ──────────────────────────────── */
  function updateItemBoxes() {
    if (!R.state) return;
    var boxes = R.state.itemBoxes || [];
    var seen = {};
    var M = window.ITEM_MESHES;
    if (M && M.animateBoxMat) M.animateBoxMat(R.T);
    var kD = 21.67;

    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      seen[b.id] = true;
      var mesh = R.itemBoxMeshes[b.id];
      if (!mesh || mesh.parent !== R.roadGroup) {
        if (mesh && mesh.parent) mesh.parent.remove(mesh);
        if (!M || !M.makeBox) continue;
        mesh = M.makeBox();
        R.itemBoxMeshes[b.id] = mesh;
        R.roadGroup.add(mesh);
        if (R._warnThrottleBoxes !== (b.id + '_' + (R.track ? R.track.id : ''))) {
          R._warnThrottleBoxes = b.id + '_' + (R.track ? R.track.id : '');
          console.warn('[3D Safeguard] Reconstructed/attached item box mesh in scene for id:', b.id);
        }
      }
      mesh.position.set(b.x, (1.6 + Math.sin(R.T * 3 + b.id * 2) * 0.25) * kD, -b.y);
      mesh.rotation.y = R.T * 1.6;
      mesh.rotation.x = 0.35;

      if (b.act) {
        mesh.visible = true;
        var pop = b.pop != null ? b.pop : 1;
        var s = (pop < 1 ? 1 + Math.sin(pop * Math.PI) * 0.4 : 1) * kD;
        mesh.scale.setScalar(Math.max(0.01, pop) * s);
      } else {
        mesh.visible = false;
      }
    }

    Object.keys(R.itemBoxMeshes).forEach(function(id) {
      if (!seen[id]) {
        var m = R.itemBoxMeshes[id];
        R.roadGroup.remove(m);
        delete R.itemBoxMeshes[id];
      }
    });
  }

  /* ── Update Item Projectiles (Discs, Missiles, Oils) ────────────────────── */
  function updateItemProjectiles() {
    if (!R.state) return;
    var M = window.ITEM_MESHES;
    var FX = window.FX_PARTICLES;
    var kD = 21.67;

    // 1. Discs (bouncing green disc)
    var discs = R.state.itemDiscs || [];
    var seenDiscs = {};
    for (var d = 0; d < discs.length; d++) {
      var disc = discs[d];
      seenDiscs[disc.id] = true;
      var dMesh = R.discMeshes[disc.id];
      if (!dMesh || dMesh.parent !== R.roadGroup) {
        if (dMesh && dMesh.parent) dMesh.parent.remove(dMesh);
        if (!M || !M.makeDisc) continue;
        dMesh = M.makeDisc();
        dMesh.scale.setScalar(kD);
        R.discMeshes[disc.id] = dMesh;
        R.roadGroup.add(dMesh);
      }
      var hop = Math.abs(Math.sin(R.T * 8 + disc.id)) * 0.6 * kD;
      dMesh.position.set(disc.x, 0.9 * kD + hop, -disc.y);
      dMesh.rotation.y += 0.15;
      if (FX && FX.emit) {
        FX.emit(dMesh.position, new THREE.Vector3(0, 0.5 * kD, 0), 0x4dff9a, 0.3, 1.1 * kD, 0.5, true, 0);
      }
    }
    Object.keys(R.discMeshes).forEach(function(id) {
      if (!seenDiscs[id]) {
        R.roadGroup.remove(R.discMeshes[id]);
        delete R.discMeshes[id];
      }
    });

    // 2. Missiles (red homing missile)
    var missiles = R.state.itemMissiles || [];
    var seenMissiles = {};
    for (var m = 0; m < missiles.length; m++) {
      var miss = missiles[m];
      seenMissiles[miss.id] = true;
      var mMesh = R.missileMeshes[miss.id];
      if (!mMesh || mMesh.parent !== R.roadGroup) {
        if (mMesh && mMesh.parent) mMesh.parent.remove(mMesh);
        if (!M || !M.makeMissile) continue;
        mMesh = M.makeMissile();
        mMesh.scale.setScalar(kD);
        R.missileMeshes[miss.id] = mMesh;
        R.roadGroup.add(mMesh);
      }
      mMesh.position.set(miss.x, 0.9 * kD, -miss.y);
      var ang = miss.ang || 0;
      var fwdX = Math.cos(ang), fwdZ = -Math.sin(ang);
      mMesh.lookAt(mMesh.position.x + fwdX, mMesh.position.y, mMesh.position.z + fwdZ);
      if (FX && FX.emit) {
        var tail = mMesh.position.clone().add(new THREE.Vector3(-fwdX * 1.4 * kD, 0, -fwdZ * 1.4 * kD));
        FX.emit(tail, new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2), 0xffa030, 0.25, 1.4 * kD, 0.3, true, 0);
        FX.emit(tail, new THREE.Vector3(0, 1.2 * kD, 0), 0x777777, 0.7, 1.4 * kD, 1.6, false, 0);
      }
    }
    Object.keys(R.missileMeshes).forEach(function(id) {
      if (!seenMissiles[id]) {
        R.roadGroup.remove(R.missileMeshes[id]);
        delete R.missileMeshes[id];
      }
    });

    // 3. Oils (dark growing puddle)
    var oils = R.state.itemOils || [];
    var seenOils = {};
    for (var o = 0; o < oils.length; o++) {
      var oil = oils[o];
      seenOils[oil.id] = true;
      var oMesh = R.oilMeshes[oil.id];
      if (!oMesh || oMesh.parent !== R.roadGroup) {
        if (oMesh && oMesh.parent) oMesh.parent.remove(oMesh);
        if (!M || !M.makeOil) continue;
        oMesh = M.makeOil();
        R.oilMeshes[oil.id] = oMesh;
        R.roadGroup.add(oMesh);
      }
      oMesh.position.set(oil.x, 0.07 * kD, -oil.y);
      var lifeLeft = oil.life != null ? oil.life : 14;
      var age = 14 - lifeLeft;
      var grow = Math.min(1, age * 4);
      oMesh.scale.set(grow * kD, kD, grow * kD);
    }
    Object.keys(R.oilMeshes).forEach(function(id) {
      if (!seenOils[id]) {
        R.roadGroup.remove(R.oilMeshes[id]);
        delete R.oilMeshes[id];
      }
    });
  }

  function updateProjectiles() {
    clearGroup(R.projectileGroup);
    if (!R.state || !R.state.projs) return;
    R.state.projs.forEach(function(p) {
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(p.explosive ? 7 : 4, 12, 8), new THREE.MeshBasicMaterial({ color: p.c || '#ffd166' }));
      mesh.position.set(p.x, 9, -p.y);
      R.projectileGroup.add(mesh);
    });
  }

  function triggerPowerEffect(effect) {
    if (!effect || effect.x == null || effect.y == null || !R.powerEffectGroup) return;
    var color = effect.type === 'lightning' ? '#8ecae6' :
      effect.type === 'rocket' ? '#ff7b00' :
      effect.type === 'banana' ? '#f4d35e' :
      effect.type === 'frenzy' ? '#ff6b35' : '#ffd166';
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(14, 1.8, 8, 28),
      new THREE.MeshPhongMaterial({
        color: color,
        emissive: color,
        transparent: true,
        opacity: 0.9,
      })
    );
    ring.position.set(effect.x, 4, -effect.y);
    ring.rotation.x = Math.PI / 2;
    R.powerEffectGroup.add(ring);
    R.powerEffects.push({ mesh: ring, start: Date.now(), life: effect.type === 'lightning' ? 850 : 650 });
  }

  function updatePowerEffects() {
    var now = Date.now();
    for (var i = R.powerEffects.length - 1; i >= 0; i--) {
      var effect = R.powerEffects[i];
      var progress = (now - effect.start) / effect.life;
      if (progress >= 1) {
        R.powerEffectGroup.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        effect.mesh.material.dispose();
        R.powerEffects.splice(i, 1);
        continue;
      }
      var scale = 1 + progress * 4;
      effect.mesh.scale.set(scale, scale, scale);
      effect.mesh.material.opacity = 0.9 * (1 - progress);
      effect.mesh.rotation.z += 0.08;
    }
  }

  function updatePickupAnimations() {
    var now = Date.now();
    R.pickupMeshes.forEach(function(item) {
      if (!item.box.parent) return;
      item.box.position.y = item.baseY + Math.sin(now / 420 + item.phase) * 3;
      item.box.rotation.y += 0.018;
      item.box.rotation.x += 0.006;
      item.box.scale.setScalar(1 + Math.sin(now / 260 + item.phase) * 0.06);
    });
  }

  /* ── 2D Canvas HUD Overlay ─────────────────────────────────────────────── */
  function drawHud() {
    if (!R.hud) return;
    var ctx = R.hud.getContext('2d'), dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, R.hud.width, R.hud.height);
    var local = getLocal();
    if (!local) return;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Speedometer
    ctx.fillStyle = '#07101de0';
    ctx.fillRect(18, 18, 120, 62);
    ctx.fillStyle = '#00f5d4';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(Math.round((local.spd || 0) * 0.5), 28, 52);
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.fillText('km/h', 30, 70);

    // Position
    ctx.fillStyle = '#07101de0';
    ctx.fillRect(innerWidth / 2 - 62, 18, 124, 48);
    ctx.fillStyle = '#f72585';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    var totalLaps = (R.state && R.state.laps) || 3;
    var currentLap = Math.min(totalLaps, (local.lap || 0) + (local.fin ? 0 : 1));
    ctx.fillText(currentLap + '/' + totalLaps, innerWidth / 2, 42);
    ctx.fillStyle = '#ffffffaa';
    ctx.font = '10px sans-serif';
    ctx.fillText('VUELTA', innerWidth / 2, 57);

    // Position badge
    ctx.fillStyle = '#07101de0';
    var posText = (local.pos ? local.pos + 'º' : '—');
    ctx.fillRect(18, 90, 70, 36);
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(posText, 53, 114);

    // Arcade Item Box (Top Right)
    if (ARCADE) {
      var boxW = 160, boxH = 54;
      var bx = innerWidth - boxW - 18, by = 18;
      ctx.fillStyle = '#07101de0';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 8);
      else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.strokeStyle = '#ffffff25';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      var item = local.power || local.item;
      var isRolling = Boolean(local.rolling);

      if (isRolling) {
        var rollIdx = Math.floor(R.T * 14) % ITEM_KEYS.length;
        var rollItem = ITEM_DATA[ITEM_KEYS[rollIdx]];
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(rollItem.icon, bx + 28, by + 34);
        ctx.fillStyle = '#ffb703';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText('…', bx + 95, by + 33);
      } else if (item && ITEM_DATA[item]) {
        var it = ITEM_DATA[item];
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(it.icon, bx + 28, by + 34);
        ctx.fillStyle = it.col || '#00f5d4';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(it.name, bx + 95, by + 28);
        ctx.fillStyle = '#ffffffaa';
        ctx.font = '10px sans-serif';
        ctx.fillText('PODER / [E]', bx + 95, by + 44);
      } else {
        ctx.fillStyle = '#ffffff55';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⭕', bx + 28, by + 34);
        ctx.fillStyle = '#ffffff77';
        ctx.font = '12px sans-serif';
        ctx.fillText('Sin ítem', bx + 95, by + 33);
      }
    } else {
      ctx.fillStyle = '#07101de0';
      ctx.fillRect(innerWidth - 135, 18, 115, 42);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('P' + (local.pos || '?'), innerWidth - 77, 46);
    }

    // Toast message banner
    if (_toastAlpha > 0 && _toastText) {
      ctx.save();
      ctx.globalAlpha = _toastAlpha;
      ctx.font = 'bold 15px sans-serif';
      var tw = ctx.measureText(_toastText).width + 36;
      var th = 36;
      var tx = (innerWidth - tw) / 2;
      var ty = innerHeight - 90;
      ctx.fillStyle = 'rgba(7, 16, 29, 0.88)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx, ty, tw, th, 18);
      else ctx.rect(tx, ty, tw, th);
      ctx.fill();
      ctx.strokeStyle = '#00f5d455';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(_toastText, innerWidth / 2, ty + 23);
      ctx.restore();
    }

    // Missile warning pulsing red vignette
    if (Date.now() < _missileWarnEnd) {
      var pulse = 0.35 + Math.sin(Date.now() / 120) * 0.25;
      ctx.strokeStyle = 'rgba(230, 57, 70, ' + pulse + ')';
      ctx.lineWidth = 14;
      ctx.strokeRect(0, 0, innerWidth, innerHeight);

      ctx.fillStyle = 'rgba(230, 57, 70, 0.9)';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ ¡MISIL BUSCADOR EN CAMINO! ⚠️', innerWidth / 2, 90);
    }

    ctx.textAlign = 'left';
    drawMiniMap(ctx, local);

    // Countdown
    var remain = Math.ceil((R.countdownEnd - Date.now()) / 1000);
    if (remain > 0 && remain <= 5) {
      ctx.font = 'bold 100px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffb703';
      ctx.fillText(remain, innerWidth / 2, innerHeight / 2);
    }

    // Results overlay (championship intermission or race finished)
    if (R.results) {
      drawResultsOverlay(ctx, innerWidth, innerHeight);
    }

    ctx.restore();
  }

  function drawMiniMap(ctx, local) {
    if (!R.track || !R.state || !R.track.bounds) return;
    var size = Math.min(150, innerWidth * 0.24);
    var x = innerWidth - size - 18;
    var y = ARCADE ? 82 : 72;
    var b = R.track.bounds;
    var w = Math.max(1, b.maxX - b.minX);
    var h = Math.max(1, b.maxY - b.minY);
    var scale = (size - 16) / Math.max(w, h);
    var ox = x + 8 + (size - 16 - w * scale) / 2;
    var oy = y + 8 + (size - 16 - h * scale) / 2;
    ctx.fillStyle = '#07101de0';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 2;
    var cps = R.track.checkpoints || [];
    if (cps.length > 1) {
      ctx.beginPath();
      cps.forEach(function(cp, i) {
        var px = ox + (cp.x - b.minX) * scale;
        var py = oy + (cp.y - b.minY) * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    var start = cps[0];
    if (start) {
      ctx.fillStyle = '#f72585';
      ctx.beginPath();
      ctx.arc(ox + (start.x - b.minX) * scale, oy + (start.y - b.minY) * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    (R.state.cars || []).forEach(function(car) {
      if (!car.alive && !car.fin) return;
      ctx.fillStyle = car.st === R.seat ? '#00f5d4' : (car.clr || '#fff');
      ctx.beginPath();
      ctx.arc(ox + (car.x - b.minX) * scale, oy + (car.y - b.minY) * scale,
        car.st === R.seat ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('MAPA', x + 8, y + size - 7);
  }

  function drawResultsOverlay(ctx, W, H) {
    if (!R.results) return;
    var res = R.results.results || [];
    var standings = R.results.standings || [];
    var isChampionship = Boolean(R.results.totalRaces && R.results.totalRaces > 1);
    var isFinished = Boolean(R.results.championshipFinished);

    ctx.save();
    // Semi-transparent backdrop so new circuit and grid are visible behind
    ctx.fillStyle = 'rgba(7, 16, 29, 0.85)';
    ctx.fillRect(0, 0, W, H);

    var cardW = Math.min(W * 0.9, 780);
    var cardH = Math.min(H * 0.86, 560);
    var cardX = (W - cardW) / 2;
    var cardY = (H - cardH) / 2;

    // Card background
    ctx.fillStyle = 'rgba(13, 24, 44, 0.94)';
    ctx.strokeStyle = isFinished ? '#ffd700' : '#00f5d4';
    ctx.lineWidth = 2;
    if (ctx.roundRect) ctx.roundRect(cardX, cardY, cardW, cardH, 16);
    else ctx.rect(cardX, cardY, cardW, cardH);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.textAlign = 'center';
    ctx.fillStyle = isFinished ? '#ffd700' : '#ffffff';
    ctx.font = 'bold ' + Math.max(18, Math.min(28, cardW * 0.04)) + 'px sans-serif';
    var title = isFinished
      ? '🏆 CLASIFICACIÓN FINAL DEL CAMPEONATO 🏆'
      : (isChampionship
        ? '🏁 RESULTADOS · CARRERA ' + (R.results.raceNumber || 1) + ' DE ' + R.results.totalRaces
        : '🏁 RESULTADOS DE LA CARRERA');
    ctx.fillText(title, W / 2, cardY + 42);

    // Subtitle / Next track / Intermission countdown
    var nextTrack = R.results.nextTrackName || (R.intermission && R.intermission.nextTrackName);
    var remSec = R.intermissionEnd ? Math.max(0, Math.ceil((R.intermissionEnd - Date.now()) / 1000)) : (R.results.intermissionSeconds || 12);
    if (!isFinished && nextTrack) {
      ctx.fillStyle = '#00f5d4';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText('⏱️ Siguiente circuito: ' + nextTrack + '  ·  Comenzando en ' + remSec + 's', W / 2, cardY + 70);
    } else if (isFinished) {
      ctx.fillStyle = '#f72585';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText('¡Felicidades a todos los pilotos por completar el campeonato!', W / 2, cardY + 70);
    }

    // Table Header
    var tableY = cardY + 98;
    var colPlace = cardX + 36;
    var colName = cardX + 110;
    var colTime = cardX + cardW * 0.52;
    var colPts = cardX + cardW * 0.72;
    var colTot = cardX + cardW - 46;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('POS', colPlace, tableY);
    ctx.fillText('PILOTO', colName, tableY);
    ctx.textAlign = 'center';
    ctx.fillText('TIEMPO', colTime, tableY);
    ctx.fillText('+PTS', colPts, tableY);
    ctx.textAlign = 'right';
    ctx.fillText('TOTAL', colTot, tableY);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 24, tableY + 8);
    ctx.lineTo(cardX + cardW - 24, tableY + 8);
    ctx.stroke();

    // Rows
    var list = isFinished && standings.length > 0 ? standings : (res.length > 0 ? res : standings);
    var rowH = Math.min(36, (cardH - 170) / Math.max(1, Math.min(list.length, 10)));
    var startRowY = tableY + 28;

    for (var rIdx = 0; rIdx < list.length && rIdx < 10; rIdx++) {
      var item = list[rIdx];
      var rowY = startRowY + rIdx * rowH;
      var standing = standings.find(function(s) { return s.seatToken === item.seatToken; }) || item;
      var pColor = (item.place === 1 || rIdx === 0) ? '#ffd700' :
                   (item.place === 2 || rIdx === 1) ? '#e0e0e0' :
                   (item.place === 3 || rIdx === 2) ? '#cd7f32' : '#8899aa';

      // Alternate row highlight
      if (rIdx % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(cardX + 20, rowY - 18, cardW - 40, rowH);
      }

      // Place
      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = pColor;
      ctx.textAlign = 'left';
      var medal = (item.place === 1 || rIdx === 0) ? '🥇 ' :
                  (item.place === 2 || rIdx === 1) ? '🥈 ' :
                  (item.place === 3 || rIdx === 2) ? '🥉 ' : '';
      ctx.fillText(medal + 'P' + (item.place || (rIdx + 1)), colPlace, rowY);

      // Name
      ctx.fillStyle = item.seatToken === R.seat ? '#00f5d4' : '#ffffff';
      ctx.fillText(item.name || 'Piloto', colName, rowY);

      // Time / DNF
      ctx.textAlign = 'center';
      ctx.fillStyle = item.dnf ? '#e63946' : 'rgba(255, 255, 255, 0.75)';
      var timeStr = item.dnf ? 'DNF' : (item.time ? (item.time / 1000).toFixed(1) + 's' : '—');
      ctx.fillText(timeStr, colTime, rowY);

      // Points
      ctx.fillStyle = '#ffb703';
      ctx.fillText('+' + (item.points || 0), colPts, rowY);

      // Total Points
      ctx.textAlign = 'right';
      ctx.fillStyle = '#00f5d4';
      ctx.fillText((standing.points || item.points || 0) + ' pts', colTot, rowY);
    }

    // Host skip notice at bottom
    if (!isFinished) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.font = '12px sans-serif';
      ctx.fillText('El anfitrión puede presionar "Siguiente pista" en su control para iniciar ahora', W / 2, cardY + cardH - 18);
    }

    ctx.restore();
  }

  function getLocal() {
    if (!R.state || !R.state.cars) return null;
    return R.state.cars.find(function(c) { return c.st === R.seat; }) || R.state.cars[0];
  }

  function clearGroup(group) {
    while (group && group.children.length) {
      var child = group.children[0];
      child.traverse(function(node) {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
          if (Array.isArray(node.material)) node.material.forEach(function(material) { material.dispose(); });
          else node.material.dispose();
        }
      });
      group.remove(child);
    }
  }

  function terrainColor(type) {
    return ({ dirt: '#76533a', grass: '#384b36', sand: '#8a7547', mud: '#443426', ice: '#789eae' })[type] || '#343941';
  }

  window.__rrDebugScene = function() {
    var carsTotal = Object.keys(R.cars).length;
    var carsVisible = 0;
    var carsInScene = 0;
    Object.keys(R.cars).forEach(function(k) {
      var c = R.cars[k];
      if (c && c.visible) carsVisible++;
      if (c && c.parent === R.carGroup) carsInScene++;
    });

    var boxesTotal = Object.keys(R.itemBoxMeshes).length;
    var boxesVisible = 0;
    var boxesInScene = 0;
    Object.keys(R.itemBoxMeshes).forEach(function(k) {
      var b = R.itemBoxMeshes[k];
      if (b && b.visible) boxesVisible++;
      if (b && b.parent === R.roadGroup) boxesInScene++;
    });

    var projectileCount = (R.projectileGroup ? R.projectileGroup.children.length : 0) +
      Object.keys(R.discMeshes).length +
      Object.keys(R.missileMeshes).length +
      Object.keys(R.oilMeshes).length;

    var materialsStatus = {
      boxMaterialReady: Boolean(window.ITEM_MESHES),
      sceneChildren: R.scene ? R.scene.children.length : 0,
      carGroupChildren: R.carGroup ? R.carGroup.children.length : 0,
      roadGroupChildren: R.roadGroup ? R.roadGroup.children.length : 0,
    };

    return {
      currentTrackId: R.track ? R.track.id : null,
      trackId: R.track ? R.track.id : null,
      trackName: R.track ? R.track.name : null,
      carCount: carsInScene,
      carsCount: carsTotal,
      carsVisibleCount: carsVisible,
      carsInScene: carsInScene,
      itemBoxCount: boxesInScene,
      boxesCount: boxesTotal,
      boxesVisibleCount: boxesVisible,
      boxesInScene: boxesInScene,
      projectileCount: projectileCount,
      activeMaterialsCount: materialsStatus,
      rendererActive: Boolean(R.animId && R.renderer),
      cameraPosition: R.camera ? {
        x: +(R.camera.position.x.toFixed(1)),
        y: +(R.camera.position.y.toFixed(1)),
        z: +(R.camera.position.z.toFixed(1)),
      } : null,
      resultsActive: Boolean(R.results),
      intermissionActive: Boolean(R.intermission),
    };
  };

  window.GAME_RENDERER = {
    init: init,
    stop: stop,
    setTrack: setTrack,
    resetForNewRace: resetForNewRace,
    setGameState: setGameState,
    setCountdown: setCountdown,
    setResults: setResults,
    setIntermission: setIntermission,
    triggerPowerEffect: triggerPowerEffect,
    showToast: showToast,
    showInk: showInk,
    showMissileWarning: showMissileWarning,
    handleItemEvent: handleItemEvent,
    setArrival: function(arrival) {
      R.arrivals = R.arrivals || [];
      if (arrival && !R.arrivals.some(function(item) { return item.seatToken === arrival.seatToken; })) {
        R.arrivals.push(arrival);
      }
    },
    getLocalCar: getLocal,
    debugScene: window.__rrDebugScene
  };
})();
