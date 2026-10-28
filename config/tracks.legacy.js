/**
 * config/tracks.js
 * 10 diversified racing tracks with terrain types, curves, and championship metadata.
 * Compatible with Node.js and browser.
 */
(function() {
'use strict';

const TRACKS = [
  {
    id: 'track_01_neon_city',
    name: '1. Circuito Neon City',
    description: 'Calles metropolitanas iluminadas de asfalto liso y rectas de alta velocidad.',
    terrain: 'Asfalto puro (100%)',
    gripLevel: 'Alto',
    difficulty: 'Principiante',
    color: '#00f5d4',
    lapsDefault: 3,
    lengthMeters: 1450,
    checkpointsCount: 16
  },
  {
    id: 'track_02_dusty_canyon',
    name: '2. Cañón Polvoriento',
    description: 'Senderos de tierra rojiza entre barrancos con curvas de horquilla y derrapes constantes.',
    terrain: 'Tierra y grava (85%)',
    gripLevel: 'Bajo / Derrape alto',
    difficulty: 'Media',
    color: '#d4a373',
    lapsDefault: 3,
    lengthMeters: 1600,
    checkpointsCount: 18
  },
  {
    id: 'track_03_cyber_docks',
    name: '3. Puerto Cyberpunk',
    description: 'Muelles portuarios con asfalto húmedo reflectante y chicanes estrechas entre contenedores.',
    terrain: 'Asfalto húmedo y metal',
    gripLevel: 'Medio-Alto',
    difficulty: 'Media',
    color: '#4361ee',
    lapsDefault: 3,
    lengthMeters: 1520,
    checkpointsCount: 20
  },
  {
    id: 'track_04_scorched_desert',
    name: '4. Desierto Calcinado',
    description: 'Gran velocidad en dunas abiertas intercaladas con saltos y zonas de arena profunda.',
    terrain: 'Arena y tierra seca',
    gripLevel: 'Variable',
    difficulty: 'Media',
    color: '#ffb703',
    lapsDefault: 3,
    lengthMeters: 1800,
    checkpointsCount: 18
  },
  {
    id: 'track_05_industrial_ruins',
    name: '5. Ruinas Industriales',
    description: 'Fábricas abandonadas con esquinas de 90 grados, tuberías y zonas de choque lateral.',
    terrain: 'Concreto y asfalto roto',
    gripLevel: 'Medio',
    difficulty: 'Difícil',
    color: '#f77f00',
    lapsDefault: 3,
    lengthMeters: 1650,
    checkpointsCount: 22
  },
  {
    id: 'track_06_skyline_highway',
    name: '6. Autopista Elevada',
    description: 'Puentes colgantes futuristas a máxima velocidad con curvas amplias y sin barandillas.',
    terrain: 'Asfalto ultrarrápido',
    gripLevel: 'Muy Alto',
    difficulty: 'Media',
    color: '#f72585',
    lapsDefault: 3,
    lengthMeters: 2100,
    checkpointsCount: 20
  },
  {
    id: 'track_07_toxic_jungle',
    name: '7. Selva Tóxica',
    description: 'Barro resbaladizo entre vegetación densa, charcos de ácido y túneles naturales.',
    terrain: 'Barro y fango (90%)',
    gripLevel: 'Muy Bajo',
    difficulty: 'Difícil',
    color: '#55a630',
    lapsDefault: 3,
    lengthMeters: 1750,
    checkpointsCount: 24
  },
  {
    id: 'track_08_subterranean_mine',
    name: '8. Mina Subterránea',
    description: 'Laberinto subterráneo claustrofóbico con pilares de roca, vías férreas y oscuridad.',
    terrain: 'Roca y grava compacta',
    gripLevel: 'Medio',
    difficulty: 'Difícil',
    color: '#6c757d',
    lapsDefault: 3,
    lengthMeters: 1580,
    checkpointsCount: 22
  },
  {
    id: 'track_09_obsidian_volcano',
    name: '9. Volcán de Obsidiana',
    description: 'Pista perimetral sobre roca volcánica con ríos de lava laterales y alta exigencia técnica.',
    terrain: 'Roca volcánica y ceniza',
    gripLevel: 'Medio-Bajo',
    difficulty: 'Experto',
    color: '#d00000',
    lapsDefault: 3,
    lengthMeters: 1950,
    checkpointsCount: 26
  },
  {
    id: 'track_10_omega_grand_prix',
    name: '10. Gran Premio Omega',
    description: 'El circuito definitivo que combina todas las superficies: asfalto, túnel, tierra y saltos.',
    terrain: 'Superficie Mixta Total',
    gripLevel: 'Dinámico',
    difficulty: 'Maestro',
    color: '#7209b7',
    lapsDefault: 4,
    lengthMeters: 2400,
    checkpointsCount: 30
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TRACKS;
} else {
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.TRACKS = TRACKS;
}
})();
