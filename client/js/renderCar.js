/**
 * client/js/renderCar.js
 * 100% Procedural 2D Canvas rendering for cars and mounted weapons.
 * No external images or assets. Clean vector graphics with neon accents.
 */
'use strict';

const CAR_RENDERER = (() => {

  /**
   * Draw a procedural top-down racing car with weapon on a 2D canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx - Center X
   * @param {number} cy - Center Y
   * @param {Object} car - Car definition from CONFIG.CARS
   * @param {Object} weapon - Weapon definition from CONFIG.WEAPONS
   * @param {number} [heading=0] - Heading angle in radians (0 = pointing right)
   * @param {number} [scale=1.0] - Scale multiplier
   */
  function drawCar(ctx, cx, cy, car, weapon, heading = 0, scale = 1.0) {
    if (!car) return;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    ctx.scale(scale, scale);

    const w = (car.dimensions?.length || 64) * 0.5; // Half length along X
    const h = (car.dimensions?.width || 36) * 0.5;  // Half width along Y
    const primary = car.color || '#00f5d4';
    const accent = car.accentColor || '#ffffff';

    // 1. Soft ground shadow
    ctx.beginPath();
    ctx.ellipse(0, 4, w + 4, h + 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();

    // 2. Wheels (4 tires with rims)
    const tireW = 14;
    const tireH = 7;
    const wheelPositions = [
      { x: w * 0.65, y: -h * 0.95 },  // Front right
      { x: w * 0.65, y: h * 0.95 },   // Front left
      { x: -w * 0.65, y: -h * 0.95 }, // Rear right
      { x: -w * 0.65, y: h * 0.95 },  // Rear left
    ];

    wheelPositions.forEach(pos => {
      ctx.save();
      ctx.translate(pos.x, pos.y);
      // Tire rubber
      ctx.fillStyle = '#111317';
      ctx.beginPath();
      ctx.roundRect(-tireW / 2, -tireH / 2, tireW, tireH, 2.5);
      ctx.fill();
      // Neon rim accent
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    });

    // 3. Body base shape
    ctx.beginPath();
    switch (car.shape) {
      case 'heavy_tank':
      case 'combat_truck':
        // Boxy armored chassis
        ctx.moveTo(-w * 0.9, -h * 0.85);
        ctx.lineTo(w * 0.7, -h * 0.9);
        ctx.lineTo(w * 0.95, -h * 0.6);
        ctx.lineTo(w * 0.95, h * 0.6);
        ctx.lineTo(w * 0.7, h * 0.9);
        ctx.lineTo(-w * 0.9, h * 0.85);
        ctx.closePath();
        break;

      case 'compact_hatch':
      case 'dune_buggy':
        // Agile, tapered front
        ctx.moveTo(-w * 0.85, -h * 0.8);
        ctx.lineTo(w * 0.5, -h * 0.8);
        ctx.lineTo(w * 0.95, -h * 0.45);
        ctx.lineTo(w * 0.95, h * 0.45);
        ctx.lineTo(w * 0.5, h * 0.8);
        ctx.lineTo(-w * 0.85, h * 0.8);
        ctx.closePath();
        break;

      case 'sleek_supercar':
      case 'aero_prototype':
      default:
        // Aerodynamic arrow chassis
        ctx.moveTo(-w * 0.85, -h * 0.75);
        ctx.lineTo(w * 0.2, -h * 0.85);
        ctx.lineTo(w * 0.85, -h * 0.5);
        ctx.lineTo(w * 0.98, 0);
        ctx.lineTo(w * 0.85, h * 0.5);
        ctx.lineTo(w * 0.2, h * 0.85);
        ctx.lineTo(-w * 0.85, h * 0.75);
        ctx.closePath();
        break;
    }

    // Body gradient fill
    const grad = ctx.createLinearGradient(-w, 0, w, 0);
    grad.addColorStop(0, primary);
    grad.addColorStop(0.65, primary);
    grad.addColorStop(1, accent);
    ctx.fillStyle = grad;
    ctx.fill();

    // Body border with subtle glow
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 4. Cockpit / Windshield
    ctx.beginPath();
    ctx.moveTo(-w * 0.15, -h * 0.5);
    ctx.lineTo(w * 0.35, -h * 0.4);
    ctx.lineTo(w * 0.35, h * 0.4);
    ctx.lineTo(-w * 0.15, h * 0.5);
    ctx.closePath();
    ctx.fillStyle = '#0a0d14';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 245, 212, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Windshield reflection
    ctx.beginPath();
    ctx.moveTo(w * 0.1, -h * 0.3);
    ctx.lineTo(w * 0.28, -h * 0.25);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 5. Rear Spoiler / Wing
    ctx.save();
    ctx.fillStyle = '#111317';
    ctx.strokeStyle = primary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-w * 0.95, -h * 0.9, 6, h * 1.8, 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 6. Front Headlights (Neon glows)
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#00f5d4';
    ctx.shadowBlur = 8;
    ctx.fillRect(w * 0.82, -h * 0.5, 4, 3);
    ctx.fillRect(w * 0.82, h * 0.5 - 3, 4, 3);
    ctx.shadowBlur = 0; // Reset shadow

    // 7. Mounted Weapon
    if (weapon) {
      drawMountedWeapon(ctx, 0, 0, weapon, primary);
    }

    ctx.restore();
  }

  /**
   * Draw mounted weapon on the roof of the car
   */
  function drawMountedWeapon(ctx, x, y, weapon, carPrimary) {
    ctx.save();
    ctx.translate(x, y);

    const wColor = weapon.color || '#ff0055';

    // Turret base ring
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#1b1e28';
    ctx.fill();
    ctx.strokeStyle = wColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Barrels according to weapon type
    ctx.fillStyle = '#2b2d42';
    ctx.strokeStyle = wColor;
    ctx.lineWidth = 2;

    switch (weapon.id) {
      case 'vulcan_mg':
        // Dual gatling barrels
        ctx.fillRect(3, -4, 15, 3);
        ctx.fillRect(3, 1, 15, 3);
        break;

      case 'thunder_shotgun':
        // Short wide double barrel
        ctx.fillRect(2, -5, 12, 10);
        ctx.fillStyle = wColor;
        ctx.fillRect(12, -4, 3, 8);
        break;

      case 'goliath_bazooka':
        // Heavy wide tube with missile tip
        ctx.fillRect(0, -5, 18, 10);
        ctx.fillStyle = '#e63946';
        ctx.beginPath();
        ctx.moveTo(18, -4);
        ctx.lineTo(24, 0);
        ctx.lineTo(18, 4);
        ctx.fill();
        break;

      case 'stalker_rockets':
        // Quad missile pod
        ctx.fillRect(-2, -7, 14, 14);
        ctx.fillStyle = '#b5179e';
        ctx.fillRect(12, -5, 3, 3);
        ctx.fillRect(12, 2, 3, 3);
        break;

      case 'inferno_flame':
        // Flame nozzle with pilot flame
        ctx.fillRect(2, -3.5, 14, 7);
        ctx.fillStyle = '#f3722c';
        ctx.beginPath();
        ctx.arc(17, 0, 3, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'hyper_railgun':
        // Long magnetic rails
        ctx.fillRect(0, -2, 22, 4);
        ctx.strokeStyle = '#00f5d4';
        ctx.beginPath();
        ctx.moveTo(4, -4);
        ctx.lineTo(24, -4);
        ctx.moveTo(4, 4);
        ctx.lineTo(24, 4);
        ctx.stroke();
        break;

      case 'spike_mines':
        // Rear mine launcher rack
        ctx.fillRect(-12, -6, 10, 12);
        ctx.fillStyle = '#f72585';
        ctx.beginPath();
        ctx.arc(-14, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        break;

      default:
        ctx.fillRect(2, -2.5, 14, 5);
        break;
    }

    ctx.restore();
  }

  /**
   * Helper to render an animated preview on an HTML canvas
   */
  function startPreviewAnimation(canvas, getCarFn, getWeaponFn) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    let angle = 0;
    let animId = null;

    function render() {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Radial dark background gradient
      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, width / 2);
      bgGrad.addColorStop(0, 'rgba(20, 28, 45, 0.9)');
      bgGrad.addColorStop(1, 'rgba(8, 11, 18, 0.95)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Subtle rotating neon ring in background
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(angle * 0.5);
      ctx.strokeStyle = 'rgba(0, 245, 212, 0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 12]);
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(width, height) * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const car = getCarFn();
      const weapon = getWeaponFn();

      // Slow elegant 360 rotation with floating effect
      angle += 0.015;
      const floatY = Math.sin(angle * 2) * 3;

      drawCar(ctx, width / 2, height / 2 + floatY, car, weapon, angle, 1.4);

      animId = requestAnimationFrame(render);
    }

    animId = requestAnimationFrame(render);

    return {
      stop: () => cancelAnimationFrame(animId)
    };
  }

  return {
    drawCar,
    drawMountedWeapon,
    startPreviewAnimation,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CAR_RENDERER;
} else {
  window.CAR_RENDERER = CAR_RENDERER;
}
