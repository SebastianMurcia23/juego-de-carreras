/**
 * config/cars.js
 * 10 distinct cars with balanced stats, tactical roles, and procedural rendering palettes.
 * Compatible with Node.js (CommonJS) and browser (window.CONFIG.CARS).
 */
(function() {
'use strict';

const CARS = [
  {
    id: 'apex_venom',
    name: 'Apex Venom',
    role: 'Superdeportivo Ultrarrápido',
    tagline: 'Velocidad punta letal a costa de blindaje',
    color: '#00f5d4', // Neon Cyan
    accentColor: '#7b2cbf',
    stats: {
      maxSpeed: 96,      // Relative rating; physics multiplier raises the overall pace
      acceleration: 92,
      handling: 78,
      drift: 65,
      armor: 45,        // Frágil
      weight: 42,
      traction: { asphalt: 95, dirt: 50, grass: 35 }
    },
    dimensions: { width: 34, length: 64 },
    shape: 'sleek_supercar'
  },
  {
    id: 'goliath_mk4',
    name: 'Goliath Mk4',
    role: 'Tanque Pesado Blindado',
    tagline: 'Una fortaleza sobre ruedas imposible de empujar',
    color: '#3a5a40', // Camo Green
    accentColor: '#e76f51',
    stats: {
      maxSpeed: 62,
      acceleration: 52,
      handling: 48,
      drift: 35,
      armor: 100,       // Resistencia máxima
      weight: 98,
      traction: { asphalt: 80, dirt: 85, grass: 75 }
    },
    dimensions: { width: 44, length: 72 },
    shape: 'heavy_tank'
  },
  {
    id: 'drift_phantom',
    name: 'Drift Phantom',
    role: 'Especialista en Derrapes',
    tagline: 'Deslízate en cada curva sin perder impulso',
    color: '#f72585', // Neon Pink
    accentColor: '#4cc9f0',
    stats: {
      maxSpeed: 82,
      acceleration: 86,
      handling: 92,
      drift: 98,        // Rey del derrape
      armor: 58,
      weight: 54,
      traction: { asphalt: 90, dirt: 78, grass: 45 }
    },
    dimensions: { width: 35, length: 62 },
    shape: 'drift_tuner'
  },
  {
    id: 'mud_crusher',
    name: 'Mud Crusher',
    role: 'Especialista Off-Road',
    tagline: 'Domina el barro y la tierra como si fuera asfalto',
    color: '#d4a373', // Desert Sand
    accentColor: '#606c38',
    stats: {
      maxSpeed: 74,
      acceleration: 82,
      handling: 70,
      drift: 72,
      armor: 82,
      weight: 78,
      traction: { asphalt: 75, dirt: 98, grass: 88 } // Tracción superior en tierra
    },
    dimensions: { width: 42, length: 66 },
    shape: 'offroad_4x4'
  },
  {
    id: 'viper_gt',
    name: 'Viper GT',
    role: 'Equilibrado Clásico',
    tagline: 'El balance perfecto entre velocidad, curvas y resistencia',
    color: '#ffb703', // Cyber Gold
    accentColor: '#fb8500',
    stats: {
      maxSpeed: 80,
      acceleration: 80,
      handling: 80,
      drift: 75,
      armor: 72,
      weight: 68,
      traction: { asphalt: 88, dirt: 72, grass: 55 }
    },
    dimensions: { width: 36, length: 65 },
    shape: 'balanced_gt'
  },
  {
    id: 'nitro_wasp',
    name: 'Nitro Wasp',
    role: 'Mosquito Ágil y Ligero',
    tagline: 'Aceleración explosiva y giros hiper cerrados',
    color: '#fee440', // Electric Yellow
    accentColor: '#111111',
    stats: {
      maxSpeed: 85,
      acceleration: 98, // Arranque instantáneo
      handling: 96,
      drift: 60,
      armor: 40,
      weight: 36,       // Muy ligero
      traction: { asphalt: 92, dirt: 55, grass: 40 }
    },
    dimensions: { width: 32, length: 56 },
    shape: 'compact_hatch'
  },
  {
    id: 'iron_boar',
    name: 'Iron Boar',
    role: 'Muscle Car Agresivo',
    tagline: 'Fuerza bruta V8 y derrape en línea recta',
    color: '#9e2a2b', // Deep Crimson
    accentColor: '#ffffff',
    stats: {
      maxSpeed: 88,
      acceleration: 74,
      handling: 58,
      drift: 84,
      armor: 84,
      weight: 86,
      traction: { asphalt: 86, dirt: 68, grass: 48 }
    },
    dimensions: { width: 38, length: 68 },
    shape: 'muscle_car'
  },
  {
    id: 'cyber_storm',
    name: 'Cyber Storm',
    role: 'Prototipo Aerodinámico',
    tagline: 'Aero futurista con agarre supremo en curvas rápidas',
    color: '#4361ee', // Electric Blue
    accentColor: '#4cc9f0',
    stats: {
      maxSpeed: 92,
      acceleration: 88,
      handling: 84,
      drift: 74,
      armor: 62,
      weight: 56,
      traction: { asphalt: 98, dirt: 62, grass: 45 }
    },
    dimensions: { width: 35, length: 66 },
    shape: 'aero_prototype'
  },
  {
    id: 'dune_raider',
    name: 'Dune Raider',
    role: 'Buggy Todo Terreno',
    tagline: 'Suspensión alta, saltarín y veloz en terrenos difíciles',
    color: '#f3722c', // Bright Orange
    accentColor: '#277da1',
    stats: {
      maxSpeed: 77,
      acceleration: 84,
      handling: 86,
      drift: 88,
      armor: 68,
      weight: 52,
      traction: { asphalt: 78, dirt: 94, grass: 82 }
    },
    dimensions: { width: 40, length: 60 },
    shape: 'dune_buggy'
  },
  {
    id: 'titan_roller',
    name: 'Titan Roller',
    role: 'Camión de Asalto Pesado',
    tagline: 'Aplasta todo a su paso con blindaje y empuje sísmico',
    color: '#5c677d', // Industrial Steel
    accentColor: '#f77f00',
    stats: {
      maxSpeed: 60,
      acceleration: 64,
      handling: 42,
      drift: 40,
      armor: 98,
      weight: 100,      // El más pesado de todos
      traction: { asphalt: 82, dirt: 88, grass: 78 }
    },
    dimensions: { width: 46, length: 76 },
    shape: 'combat_truck'
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CARS;
} else {
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.CARS_F1 = CARS;
}
})();
