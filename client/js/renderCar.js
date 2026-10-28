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
    const ARCADE = (typeof window !== 'undefined' && window.ROAD_RUMBLE_FLAGS && window.ROAD_RUMBLE_FLAGS.ARCADE_ITEMS !== false);
    if (ARCADE) weapon = null;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    ctx.scale(scale, scale);

    drawFormulaCar(ctx, car, weapon);
    ctx.restore();
    return;
  }

  function drawFormulaCar(ctx, car, weapon) {
    const length = car.dimensions?.length || 64;
    const width = car.dimensions?.width || 36;
    const unit = length / 65;
    const primary = car.color || '#00f5d4';
    const accent = car.accentColor || '#ffffff';
    const rearScale = car.id === 'goliath_mk4' || car.id === 'titan_roller' || car.id === 'iron_boar' ? 1.15 : 1;
    const frontWingScale = car.id === 'apex_venom' || car.id === 'cyber_storm' ? 1.12 : 1;
    const tireScale = car.id === 'mud_crusher' || car.id === 'dune_raider' ? 1.25 : rearScale;
    const halfLength = length / 2;
    const halfWidth = width / 2;

    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    ctx.ellipse(-2 * unit, 4 * unit, halfLength * 0.9, halfWidth * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    const tireWidth = Math.max(3, width * 0.13);
    const frontTireLength = Math.max(7, width * 0.2);
    const rearTireLength = frontTireLength * tireScale;
    const frontX = halfLength * 0.48;
    const rearX = -halfLength * 0.46;
    for (const wheel of [
      { x: frontX, y: -halfWidth * 0.96, length: frontTireLength },
      { x: frontX, y: halfWidth * 0.96, length: frontTireLength },
      { x: rearX, y: -halfWidth * 1.02, length: rearTireLength },
      { x: rearX, y: halfWidth * 1.02, length: rearTireLength },
    ]) {
      ctx.fillStyle = '#111317';
      ctx.fillRect(wheel.x - wheel.length / 2, wheel.y - tireWidth / 2, wheel.length, tireWidth);
      ctx.strokeStyle = '#737b84';
      ctx.lineWidth = Math.max(1, unit);
      ctx.strokeRect(wheel.x - wheel.length / 2, wheel.y - tireWidth / 2, wheel.length, tireWidth);
    }

    ctx.fillStyle = '#1a1d22';
    ctx.fillRect(-halfLength * 0.63, -halfWidth * 0.82, halfLength * 1.32, halfWidth * 1.64);

    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.moveTo(-halfLength * 0.62, -halfWidth * 0.62);
    ctx.lineTo(halfLength * 0.48, -halfWidth * 0.38);
    ctx.lineTo(halfLength * 0.82, 0);
    ctx.lineTo(halfLength * 0.48, halfWidth * 0.38);
    ctx.lineTo(-halfLength * 0.62, halfWidth * 0.62);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#10131a';
    ctx.beginPath();
    ctx.moveTo(-halfLength * 0.14, -halfWidth * 0.34);
    ctx.lineTo(halfLength * 0.22, -halfWidth * 0.25);
    ctx.lineTo(halfLength * 0.22, halfWidth * 0.25);
    ctx.lineTo(-halfLength * 0.14, halfWidth * 0.34);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = accent;
    ctx.fillRect(-halfLength * 0.35, -Math.max(1, width * 0.025), halfLength * 0.72, Math.max(2, width * 0.05));

    ctx.fillStyle = '#1a1d22';
    ctx.fillRect(-halfLength * 0.86, -halfWidth * 1.12, width * 0.09, halfWidth * 2.24);
    ctx.fillRect(halfLength * 0.76, -halfWidth * 1.2, width * 0.08 * frontWingScale, halfWidth * 2.4 * frontWingScale);

    ctx.fillStyle = '#f7f7f7';
    ctx.beginPath();
    ctx.arc(halfLength * 0.05, 0, Math.max(1.5, width * 0.06), 0, Math.PI * 2);
    ctx.fill();

    if (weapon) drawMountedWeapon(ctx, 0, 0, weapon, primary);
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
