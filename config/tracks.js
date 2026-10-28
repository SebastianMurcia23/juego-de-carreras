/**
 * Active track catalog.
 * The legacy catalog remains untouched in tracks.legacy.js.
 */
(function() {
'use strict';

  const flags = typeof module !== 'undefined' && module.exports
    ? require('./feature-flags')
    : (window.ROAD_RUMBLE_FLAGS || {});
  const source = flags.USE_F1_TRACKS_AND_CARS ? './tracks.f1.js' : './tracks.legacy.js';

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = require(source);
  } else {
    window.CONFIG = window.CONFIG || {};
    window.CONFIG.TRACKS = flags.USE_F1_TRACKS_AND_CARS
      ? window.CONFIG.TRACKS_F1
      : window.CONFIG.TRACKS;
  }
})();
