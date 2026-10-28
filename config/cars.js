/**
 * Active car catalog.
 * The legacy catalog remains untouched in cars.legacy.js.
 */
(function() {
'use strict';

  const flags = typeof module !== 'undefined' && module.exports
    ? require('./feature-flags')
    : (window.ROAD_RUMBLE_FLAGS || {});
  const source = flags.USE_F1_TRACKS_AND_CARS ? './cars.f1.js' : './cars.legacy.js';

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = require(source);
  } else {
    window.CONFIG = window.CONFIG || {};
    window.CONFIG.CARS = flags.USE_F1_TRACKS_AND_CARS
      ? window.CONFIG.CARS_F1
      : window.CONFIG.CARS;
  }
})();
