/**
 * config/scoring.js
 * Scoring rules, points per race position, kill bonuses, and championship rankings.
 * Compatible with Node.js and browser.
 */
(function() {
'use strict';

const SCORING = {
  // Official points assigned by final race position (1st to 12th)
  positionPoints: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0],

  // Extra combat and performance bonuses
  pointsPerKill: 3,
  pointsPerSpecialBox: 2,
  pointsFastestLap: 2,
  penaltyPerDeath: -1,

  // Fallback for players beyond 12th place
  defaultRemainingPoints: 0
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCORING;
} else {
  window.CONFIG = window.CONFIG || {};
  window.CONFIG.SCORING = SCORING;
}
})();
