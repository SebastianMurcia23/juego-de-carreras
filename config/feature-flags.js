/**
 * Feature flags shared by server-side catalog selection and browser setup.
 * F1 data is staged separately; keep the default disabled until Phase 2.
 */
(function() {
'use strict';

  const FLAGS = {
    USE_F1_TRACKS_AND_CARS: true,
    USE_REAL_SCENERY: false,
    /** When true: 6 arcade power-ups replace weapons. When false: classic weapon mode. */
    ARCADE_ITEMS: true,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FLAGS;
  } else {
    window.ROAD_RUMBLE_FLAGS = FLAGS;
  }
})();
