/* Procedural WebGL race view. Uses the existing authoritative snapshots. */
(function() {
  'use strict';
  var canvasRendererFallback = window.GAME_RENDERER;
  if (!window.THREE) {
    console.warn('[3D] Three.js unavailable; keeping Canvas renderer');
    return;
  }

  var R = {
    canvas: null, glCanvas: null, hud: null, renderer: null, scene: null,
    camera: null, track: null, state: null, seat: null, cars: {},
    projectiles: [], running: false, countdownEnd: 0, results: null,
    roadGroup: null, carGroup: null, projectileGroup: null,
    composer: null, audio: null, fallbackMode: false
  };

  function init(canvasId, seat) {
    R.running = false;
    R.fallbackMode = false;
    if (R.glCanvas && R.glCanvas.parentNode) R.glCanvas.parentNode.removeChild(R.glCanvas);
    if (R.hud && R.hud.parentNode) R.hud.parentNode.removeChild(R.hud);
    R.canvas = document.getElementById(canvasId);
    R.seat = seat;
    if (!R.canvas) return;
    try {
      R.glCanvas = document.createElement('canvas');
      R.glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:none;';
      R.canvas.parentNode.insertBefore(R.glCanvas, R.canvas);
      R.hud = document.createElement('canvas');
      R.hud.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;';
      R.canvas.parentNode.appendChild(R.hud);
      R.renderer = new THREE.WebGLRenderer({ canvas: R.glCanvas, antialias: true });
      R.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      R.renderer.shadowMap.enabled = true;
      R.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      R.scene = new THREE.Scene();
      R.scene.background = new THREE.Color('#8ba9b2');
      R.scene.fog = new THREE.Fog('#8ba9b2', 500, 3000);
      R.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 5000);
      R.roadGroup = new THREE.Group();
      R.carGroup = new THREE.Group();
      R.projectileGroup = new THREE.Group();
      R.scene.add(R.roadGroup, R.carGroup, R.projectileGroup);
      R.scene.add(new THREE.HemisphereLight('#d9f3ff', '#29422c', 1.8));
      var sun = new THREE.DirectionalLight('#fff0d0', 2.2);
      sun.position.set(-300, 500, 250);
      sun.castShadow = true;
      R.scene.add(sun);
      if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass) {
        try {
          R.composer = new THREE.EffectComposer(R.renderer);
          R.composer.addPass(new THREE.RenderPass(R.scene, R.camera));
          R.composer.addPass(new THREE.UnrealBloomPass(
            new THREE.Vector2(R.canvas.clientWidth || 1280, R.canvas.clientHeight || 720),
            0.16, 0.35, 0.86
          ));
        } catch (postprocessError) {
          console.warn('[3D] Postprocess unavailable; continuing without bloom:', postprocessError);
          R.composer = null;
        }
      }
      try {
        setupEngineAudio();
      } catch (audioError) {
        console.warn('[3D] Engine audio unavailable; continuing without audio:', audioError);
        R.audio = null;
      }
      window.addEventListener('pointerdown', startEngineAudio, { once: true });
      window.addEventListener('resize', resize);
      resize();
      R.canvas.style.visibility = 'hidden';
      R.running = true;
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

  function setTrack(track) {
    if (R.fallbackMode && canvasRendererFallback) {
      canvasRendererFallback.setTrack(track);
      return;
    }
    R.track = track;
    clearGroup(R.roadGroup);
    if (!track || !track.checkpoints) return;
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshLambertMaterial({ color: '#496b43' })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    R.roadGroup.add(ground);
    var cps = track.checkpoints;
    var asphalt = makeAsphaltMaterial();
    var roadWidth = (track.roadHalfWidth || 65) * 2;
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

      // Formula-style kerbs follow the fixed track instead of moving with
      // the camera. Alternating blocks make the racing line readable.
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

      if (i % 2 === 0) {
        [-1, 1].forEach(function(side) {
          var barrier = new THREE.Mesh(
            new THREE.BoxGeometry(5, 7, Math.min(len * 0.8, 70)),
            new THREE.MeshLambertMaterial({ color: '#6f7780' })
          );
          barrier.position.set(
            road.position.x + Math.cos(road.rotation.y) * side * (roadWidth / 2 + 8),
            3.2,
            road.position.z - Math.sin(road.rotation.y) * side * (roadWidth / 2 + 8)
          );
          barrier.rotation.y = road.rotation.y;
          barrier.castShadow = true;
          R.roadGroup.add(barrier);
        });
      }
    }
    addRoadside(track);
    addCircuitFurniture(track);
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

  function addCircuitFurniture(track) {
    var cps = track.checkpoints;
    for (var i = 0; i < cps.length; i += 8) {
      var cp = cps[i];
      var next = cps[(i + 1) % cps.length];
      var angle = Math.atan2(next.x - cp.x, -(next.y - cp.y));
      var grandstand = new THREE.Group();
      var base = new THREE.Mesh(new THREE.BoxGeometry(90, 8, 24), new THREE.MeshLambertMaterial({ color: '#4c5661' }));
      base.position.y = 4;
      grandstand.add(base);
      for (var row = 0; row < 3; row++) {
        var seat = new THREE.Mesh(new THREE.BoxGeometry(76 - row * 12, 3, 5), new THREE.MeshLambertMaterial({ color: row % 2 ? '#cbd2d9' : '#e63946' }));
        seat.position.set(0, 10 + row * 5, -8 + row * 5);
        grandstand.add(seat);
      }
      grandstand.position.set(cp.x + Math.cos(angle) * 150, 0, -cp.y + Math.sin(angle) * 150);
      grandstand.rotation.y = angle;
      grandstand.castShadow = true;
      R.roadGroup.add(grandstand);
    }
  }

  function addRoadside(track) {
    var cps = track.checkpoints;
    for (var i = 2; i < cps.length; i += 5) {
      var cp = cps[i], next = cps[(i + 1) % cps.length];
      var dx = next.x - cp.x, dy = next.y - cp.y;
      var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      var nx = -dy / len, ny = dx / len;
      for (var side = -1; side <= 1; side += 2) {
        var tree = new THREE.Group();
        var trunk = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 28, 8), new THREE.MeshLambertMaterial({ color: '#68452e' }));
        trunk.position.y = 14;
        var crown = new THREE.Mesh(new THREE.DodecahedronGeometry(18, 1), new THREE.MeshLambertMaterial({ color: '#2d633c' }));
        crown.position.y = 35;
        tree.add(trunk, crown);
        tree.position.set(cp.x + nx * side * 115, 0, -(cp.y + ny * side * 115));
        tree.castShadow = true;
        R.roadGroup.add(tree);
      }
    }
  }

  function setGameState(state) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setGameState(state); return; }
    R.state = state;
  }
  function setCountdown(seconds) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setCountdown(seconds); return; }
    R.countdownEnd = Date.now() + seconds * 1000;
  }
  function setResults(results) {
    if (R.fallbackMode && canvasRendererFallback) { canvasRendererFallback.setResults(results); return; }
    R.results = Array.isArray(results) ? { results: results } : results;
  }
  function stop() {
    R.running = false;
    if (R.fallbackMode && canvasRendererFallback) canvasRendererFallback.stop();
  }

  function loop() {
    if (!R.running) return;
    requestAnimationFrame(loop);
    updateCars();
    updateProjectiles();
    drawHud();
    if (R.composer) R.composer.render();
    else R.renderer.render(R.scene, R.camera);
  }

  function updateCars() {
    if (!R.state || !R.state.cars) return;
    var seen = {};
    for (var i = 0; i < R.state.cars.length; i++) {
      var data = R.state.cars[i], group = R.cars[data.st];
      seen[data.st] = true;
      if (!group) { group = makeCar(data); R.cars[data.st] = group; R.carGroup.add(group); }
      if (!group.userData.target) {
        group.position.set(data.x, 3, -data.y);
        group.userData.target = new THREE.Vector3(data.x, 3, -data.y);
      } else {
        group.userData.target.set(data.x, 3, -data.y);
        group.position.lerp(group.userData.target, data.st === R.seat ? 0.78 : 0.42);
      }
      // The car model's nose is local -Z; align it with the server heading.
      group.rotation.y = data.a - Math.PI / 2;
      if (group.userData.frontWheels) {
        group.userData.frontWheels.forEach(function(wheel) {
          wheel.rotation.y = data.steerAngle || 0;
        });
      }
      group.visible = data.alive || data.fin;
      group.userData.speed = data.spd || 0;
    }
    Object.keys(R.cars).forEach(function(key) { if (!seen[key]) R.cars[key].visible = false; });
    var local = getLocal();
    if (!local) return;
    updateEngineAudio(local.spd || 0, (local.spd || 0) > 20);
    var heading = new THREE.Vector3(Math.cos(local.a), 0, -Math.sin(local.a));
    var desired = new THREE.Vector3(local.x, 3, -local.y).addScaledVector(heading, -150).add(new THREE.Vector3(0, 75, 0));
    R.camera.position.lerp(desired, local.spd > 3 ? 0.24 : 0.32);
    var target = new THREE.Vector3(local.x, 5, -local.y).addScaledVector(heading, 90);
    R.camera.lookAt(target);
    var speedRatio = Math.max(0, Math.min(1, (local.spd || 0) / 300));
    R.camera.fov += ((62 + speedRatio * 8) - R.camera.fov) * 0.12;
    R.camera.updateProjectionMatrix();
    if (R.cars[local.st]) {
      R.cars[local.st].children.forEach(function(part) {
        if (part.geometry && part.geometry.type === 'CylinderGeometry') {
          part.rotation.x += (local.spd || 0) * 0.0025;
        }
      });
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

  function makeCar(data) {
    var g = new THREE.Group();
    var color = new THREE.Color(data.clr || '#00f5d4');
    var carbon = new THREE.MeshLambertMaterial({ color: '#10151c' });
    var body = new THREE.Mesh(new THREE.BoxGeometry(30, 7, 52), new THREE.MeshPhongMaterial({ color: color, shininess: 100 }));
    body.position.y = 7; body.castShadow = true;
    var nose = new THREE.Mesh(new THREE.ConeGeometry(9, 30, 4), new THREE.MeshPhongMaterial({ color: color, shininess: 100 }));
    nose.rotation.x = -Math.PI / 2;
    nose.scale.x = 0.72;
    nose.position.set(0, 7, -39);
    nose.castShadow = true;
    var cockpit = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.MeshPhongMaterial({ color: '#07111e', shininess: 140 }));
    cockpit.scale.set(0.78, 0.65, 1.35);
    cockpit.position.set(0, 14, 2);
    cockpit.castShadow = true;
    var rearWing = new THREE.Mesh(new THREE.BoxGeometry(42, 3, 5), carbon);
    rearWing.position.set(0, 16, 27);
    var rearWingPost = new THREE.Mesh(new THREE.BoxGeometry(4, 13, 3), carbon);
    rearWingPost.position.set(0, 11, 25);
    var frontWing = new THREE.Mesh(new THREE.BoxGeometry(48, 2, 7), carbon);
    frontWing.position.set(0, 4, -48);
    var frontWingPost = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 3), carbon);
    frontWingPost.position.set(0, 5, -42);
    var leftPod = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 22), new THREE.MeshLambertMaterial({ color: color }));
    leftPod.position.set(-19, 7, 5);
    var rightPod = leftPod.clone();
    rightPod.position.x = 19;
    g.add(body, nose, cockpit, rearWing, rearWingPost, frontWing, frontWingPost, leftPod, rightPod);
    g.userData.frontWheels = [];
    for (var x = -1; x <= 1; x += 2) for (var z = -1; z <= 1; z += 2) {
      var wheel = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 5, 16), new THREE.MeshLambertMaterial({ color: '#080a0d' }));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x * 20, 6, z * 19);
      wheel.castShadow = true;
      g.add(wheel);
      if (z < 0) g.userData.frontWheels.push(wheel);
    }

    g.userData.isFormulaCar = true;
    return g;
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

  function drawHud() {
    if (!R.hud) return;
    var ctx = R.hud.getContext('2d'), dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, R.hud.width, R.hud.height);
    var local = getLocal();
    if (!local) return;
    ctx.save(); ctx.scale(dpr, dpr);
    ctx.fillStyle = '#07101dcc'; ctx.fillRect(18, 18, 120, 62);
    ctx.fillStyle = '#00f5d4'; ctx.font = 'bold 30px sans-serif'; ctx.fillText(Math.round((local.spd || 0) * 0.5), 28, 52);
    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText('km/h', 30, 70);
    ctx.fillStyle = '#07101dcc'; ctx.fillRect(innerWidth - 135, 18, 115, 42);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.fillText('P' + (local.pos || '?'), innerWidth - 115, 46);
    var remain = Math.ceil((R.countdownEnd - Date.now()) / 1000);
    if (remain > 0 && remain <= 5) { ctx.font = 'bold 100px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffb703'; ctx.fillText(remain, innerWidth / 2, innerHeight / 2); }
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
  function terrainColor(type) { return ({ dirt: '#76533a', grass: '#384b36', sand: '#8a7547', mud: '#443426', ice: '#789eae' })[type] || '#343941'; }

  window.GAME_RENDERER = { init: init, stop: stop, setTrack: setTrack, setGameState: setGameState, setCountdown: setCountdown, setResults: setResults, getLocalCar: getLocal };
})();
