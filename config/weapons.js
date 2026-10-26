/**
 * config/weapons.js
 * 7 balanced combat weapons mounted on cars.
 * Compatible with Node.js (CommonJS) and browser (window.CONFIG.WEAPONS).
 */
(function() {
'use strict';

const WEAPONS = [
  {
    id: 'vulcan_mg',
    name: 'Ametralladora Vulcan',
    type: 'bullet',
    icon: '⚡',
    color: '#fee440',
    description: 'Cadencia infernal y facilidad de uso. Excelente para desgastar rivales a media distancia.',
    stats: {
      damage: 8,           // Por impacto
      fireRateHz: 10,       // 10 disparos por segundo
      initialAmmo: 100,
      maxAmmo: 150,
      range: 550,
      projectileSpeed: 750,
      spreadAngleDeg: 4,
      difficulty: 'Fácil'
    },
    visual: {
      barrelLength: 16,
      muzzleFlashColor: '#fff3b0',
      projectileColor: '#ffd166',
      projectileRadius: 3
    }
  },
  {
    id: 'thunder_shotgun',
    name: 'Escopeta Thunder',
    type: 'spread',
    icon: '💥',
    color: '#f77f00',
    description: 'Devastadora a bocajarro. Dispara una ráfaga de 5 perdigones con gran empuje.',
    stats: {
      damage: 18,          // Por perdigón (x5 = 90 máx)
      fireRateHz: 1.5,     // 1.5 disparos por segundo
      initialAmmo: 30,
      maxAmmo: 45,
      pellets: 5,
      range: 380,
      projectileSpeed: 650,
      spreadAngleDeg: 24,
      difficulty: 'Media'
    },
    visual: {
      barrelLength: 12,
      muzzleFlashColor: '#ff9e00',
      projectileColor: '#f77f00',
      projectileRadius: 3.5
    }
  },
  {
    id: 'goliath_bazooka',
    name: 'Bazuca Goliath',
    type: 'explosive',
    icon: '🚀',
    color: '#e63946',
    description: 'Lanza un proyectil pesado con gran radio de explosión que desestabiliza a los rivales.',
    stats: {
      damage: 65,
      splashRadius: 90,
      splashDamage: 40,
      fireRateHz: 0.9,     // Recarga lenta
      initialAmmo: 10,
      maxAmmo: 18,
      range: 700,
      projectileSpeed: 480,
      spreadAngleDeg: 0,
      difficulty: 'Media'
    },
    visual: {
      barrelLength: 20,
      muzzleFlashColor: '#e63946',
      projectileColor: '#d62828',
      projectileRadius: 6
    }
  },
  {
    id: 'stalker_rockets',
    name: 'Cohetes Guiados Stalker',
    type: 'homing',
    icon: '🎯',
    color: '#7209b7',
    description: 'Misiles inteligentes que buscan y persiguen al contrincante más cercano en su cono visual.',
    stats: {
      damage: 38,
      turnRateDegPerSec: 140, // Capacidad de giro guiado
      fireRateHz: 1.2,
      initialAmmo: 15,
      maxAmmo: 25,
      range: 650,
      projectileSpeed: 520,
      spreadAngleDeg: 0,
      difficulty: 'Fácil'
    },
    visual: {
      barrelLength: 14,
      muzzleFlashColor: '#b5179e',
      projectileColor: '#7209b7',
      projectileRadius: 5
    }
  },
  {
    id: 'inferno_flame',
    name: 'Lanzallamas Inferno',
    type: 'continuous',
    icon: '🔥',
    color: '#f3722c',
    description: 'Chorro abrasador de fuego continuo que quema y ralentiza a los carros perseguidos.',
    stats: {
      damage: 3.5,         // Por tick de contacto
      fireRateHz: 20,      // Flujo continuo
      initialAmmo: 100,    // Unidades de combustible
      maxAmmo: 150,
      range: 260,
      projectileSpeed: 380,
      spreadAngleDeg: 18,
      difficulty: 'Media'
    },
    visual: {
      barrelLength: 15,
      muzzleFlashColor: '#f8961e',
      projectileColor: '#f94144',
      projectileRadius: 10
    }
  },
  {
    id: 'hyper_railgun',
    name: 'Cañón Láser / Railgun',
    type: 'beam',
    icon: '⚡',
    color: '#00f5d4',
    description: 'Haz hiper-cinético instantáneo que atraviesa toda la pista. Requiere máxima puntería.',
    stats: {
      damage: 85,          // Daño masivo de un solo disparo
      fireRateHz: 0.6,     // Recarga lenta
      initialAmmo: 12,
      maxAmmo: 18,
      range: 950,
      projectileSpeed: 2500, // Prácticamente instantáneo
      spreadAngleDeg: 0,
      difficulty: 'Alta'
    },
    visual: {
      barrelLength: 22,
      muzzleFlashColor: '#00f5d4',
      projectileColor: '#70e000',
      projectileRadius: 3
    }
  },
  {
    id: 'spike_mines',
    name: 'Minas de Proximidad',
    type: 'mine',
    icon: '💣',
    color: '#f72585',
    description: 'Se expulsan por la parte trasera. Quedan armadas en la pista esperando al que venga detrás.',
    stats: {
      damage: 70,
      splashRadius: 75,
      fireRateHz: 1.0,
      initialAmmo: 8,
      maxAmmo: 14,
      armDelayMs: 600,     // Tiempo antes de ser letal
      triggerRadius: 40,
      difficulty: 'Táctica'
    },
    visual: {
      barrelLength: -10,   // Montada atrás
      muzzleFlashColor: '#f72585',
      projectileColor: '#b5179e',
      projectileRadius: 8
    }
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WEAPONS;
} else {
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.WEAPONS = WEAPONS;
}
})();
