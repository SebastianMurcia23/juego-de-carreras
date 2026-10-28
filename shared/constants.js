/**
 * shared/constants.js
 * Shared constants between server (CommonJS) and browser (window.SHARED).
 */
const SHARED = {};

/* ─── Socket.IO event names ─────────────────────────────────────────────── */
SHARED.EVENTS = {
  // Room lifecycle
  CREATE_ROOM:        'create_room',
  ROOM_CREATED:       'room_created',
  JOIN_ROOM:          'join_room',
  ROOM_JOINED:        'room_joined',
  ROOM_NOT_FOUND:     'room_not_found',
  ROOM_FULL:          'room_full',

  // Seat / controller linking
  LINK_SEAT:          'link_seat',
  SEAT_LINKED:        'seat_linked',      // server → computer screen of that seat
  SEAT_ALREADY_USED:  'seat_already_used',
  SEAT_INVALID:       'seat_invalid',

  // Reconnection
  RECONNECT_HOST:     'reconnect_host',
  RECONNECT_SEAT:     'reconnect_seat',   // computer screen reconnects
  RECONNECT_MOBILE:   'reconnect_mobile', // mobile reconnects
  HOST_RECONNECTED:   'host_reconnected',
  SEAT_RECONNECTED:   'seat_reconnected',

  // Player list broadcast (whole room)
  PLAYERS_UPDATED:    'players_updated',

  // Disconnection notices
  HOST_DISCONNECTED:  'host_disconnected',
  HOST_TRANSFERRED:   'host_transferred',
  PLAYER_DISCONNECTED:'player_disconnected',

  // Controller inputs (Stage 3)
  CONTROLLER_INPUT:   'controller_input',
  STEERING_INPUT:     'steering_input',

  // Stage 2: Loadout selection & Ready states
  GET_CONFIG:         'get_config',
  CONFIG_DATA:        'config_data',
  SELECT_LOADOUT:     'select_loadout',
  LOADOUT_UPDATED:    'loadout_updated',
  TOGGLE_READY:       'toggle_ready',

  // Stage 2: Admin settings & actions
  ADMIN_ACTION:       'admin_action',
  UPDATE_SETTINGS:    'update_settings',
  SETTINGS_UPDATED:   'settings_updated',
  KICK_PLAYER:        'kick_player',
  PLAYER_KICKED:      'player_kicked',
  START_GAME:         'start_game',
  GAME_STARTING:      'game_starting',

  // Stage 3 & 6: Game state & pickups
  GAME_COUNTDOWN:     'game_countdown',     // server → all: { seconds }
  GAME_STATE:         'game_state',         // server → all: full sim snapshot
  RACE_FINISHED:      'race_finished',      // server → all: final results
  CAR_FINISHED:       'car_finished',       // server → all: one car crossed the finish
  RACE_COUNTDOWN_FINISH: 'race_countdown_finish', // server → all: finish countdown timer
  CHAMPIONSHIP_INTERMISSION: 'championship_intermission', // server → all: countdown to next race
  NEXT_RACE:          'next_race',          // client → server: host skips intermission
  CHAMPIONSHIP_FINISHED:'championship_finished',
  LAP_COMPLETED:      'lap_completed',      // server → specific player
  PLAYER_ELIMINATED:  'player_eliminated',  // server → all
  TRACK_DATA:         'track_data',         // server → all: track geometry
  PICKUP_COLLECTED:   'pickup_collected',   // server → player/all: { type, carName, seatToken }
  POWERUP_EFFECT:     'powerup_effect',     // server → all: visual power activation
  BOOST_PAD_TRIGGERED:'boost_pad_triggered',// server → player: { seatToken }

  // Arcade item system events (ARCADE_ITEMS mode)
  ITEM_BOX_TAKEN:     'item_box_taken',   // server → all: { seatToken, boxId, item }
  ITEM_ROLLING:       'item_rolling',     // server → seat: { seatToken } — ruleta iniciada
  ITEM_USED:          'item_used',        // server → all: { seatToken, item }
  ITEM_HIT:           'item_hit',         // server → all: { victim, attacker, item }
  ITEM_BLOCKED:       'item_blocked',     // server → all: { seatToken, item }
  ITEM_SETTINGS:      'item_settings',    // server → all: { itemDistribution }

  // Generic error
  ERROR:              'error',
};

/* ─── Seat / room states ────────────────────────────────────────────────── */
SHARED.STATES = {
  SEAT: {
    QR:        'qr',        // Computer showing QR, waiting for phone
    LINKED:    'linked',    // Phone linked – will show car selection (Stage 2)
    SELECTING: 'selecting', // Choosing car/weapon
    READY:     'ready',     // Marked ready
  },
  ROOM: {
    LOBBY:     'lobby',
    SELECTING: 'selecting',
    COUNTDOWN: 'countdown',
    RACING:    'racing',
    RESULTS:   'results',
  },
};

/* ─── Arcade Item System ────────────────────────────────────────────────── */
/**
 * Canonical item IDs — server, client, tests must use these strings exactly.
 * The reference HTML uses 'estrella' as an alias; here the canonical id is
 * 'invencibilidad'.  The client ITEM_DATA map accepts both for backwards compat.
 */
SHARED.ARCADE = {
  ITEM_IDS:   ['turbo', 'disco', 'misil', 'aceite', 'invencibilidad', 'tinta'],
  ITEM_NAMES: {
    turbo:          'Turbo',
    disco:          'Disco rebotante',
    misil:          'Misil buscador',
    aceite:         'Mancha de aceite',
    invencibilidad: 'Invencibilidad',
    tinta:          'Tinta',
  },
  /**
   * Distribution mode ids — stored in room settings as 'itemDistribution'.
   * 'positional' : Mario Kart rank-based weight matrix.
   * 'balanced'   : Equal probability for all 6 items.
   * 'rotation'   : Items cycle in fixed order (useful for testing).
   */
  DIST_MODES: {
    POSITIONAL: 'positional',
    BALANCED:   'balanced',
    ROTATION:   'rotation',
  },
};

/* ─── Hard limits ───────────────────────────────────────────────────────── */
SHARED.LIMITS = {
  MAX_PLAYERS:              12,
  HOST_RECONNECT_TIMEOUT_MS: 60_000,
  ROOM_CODE_LENGTH:          4,
  MAX_NAME_LENGTH:           20,
};

/* ─── Physics / game constants (Stage 3) ───────────────────────────────── */
SHARED.PHYSICS = {
  TICK_RATE_HZ:      30,        // Server ticks per second (30 Hz for network)
  TICK_MS:           1000 / 30, // ~33.3ms per tick
  COUNTDOWN_SECONDS: 3,

  // Car physics (Stage 3 & Realistic Driving Model)
  ACCEL_FORCE:       620,       // px/s² (faster, punchier acceleration)
  BRAKE_FORCE:       700,       // px/s² (keeps high-speed braking responsive)
  REVERSE_FORCE:     160,       // px/s²
  FRICTION:          0.988,     // velocity damping per tick
  DRAG:              0.00015,   // aerodynamic drag coefficient
  STEER_SPEED:       2.0,       // maximum yaw rate safety limit
  STEER_SPEED_FACTOR:0.16,      // progressive high-speed steering reduction
  MIN_SPEED_TO_STEER:16,        // px/s; prevents spinning in place
  WHEELBASE:         48,         // virtual wheelbase in world pixels
  MAX_STEER_ANGLE:   0.62,       // about 35 degrees at full steering
  STEER_RESPONSE:    14.0,       // steering wheel response per second

  // Drift mechanics & Lateral tire grip
  LATERAL_GRIP_NORMAL: 0.84,    // High lateral tire grip: car turns where wheels point
  LATERAL_GRIP_DRIFT:  0.38,    // Drift slip: tail breaks away smoothly into slide
  DRIFT_GRIP_MULT:   0.38,      // backward compat
  DRIFT_STEER_BOOST: 1.5,       // steering boost while drifting
  DRIFT_SPEED_RETAIN:0.95,      // speed retained when entering drift
  CAR_SPEED_MULTIPLIER: 1.8,    // faster top speed while preserving each car's stat ratio
  SPEED_DISPLAY_FACTOR: 0.5,    // world px/s to dashboard km/h

  // Terrain grip multipliers
  TERRAIN_GRIP: {
    asphalt: 1.0,
    dirt:    0.72,
    grass:   0.55,
    mud:     0.42,
    sand:    0.50,
    rock:    0.78,
    ice:     0.30,
  },

  // Collision
  CAR_RADIUS:        18,        // collision circle radius (px)
  WALL_BOUNCE:       0.35,      // velocity retained on wall hit
  CAR_BOUNCE:        0.5,       // velocity retained on car-car hit
  COLLISION_DAMAGE:  5,         // HP lost on collision

  // Health
  MAX_HEALTH:        100,
  RESPAWN_TIME_MS:   3000,
  RESPAWN_INVULN_MS: 2000,

  // Track
  // TRACK_WIDTH_SCALE: factor to scale all road widths at once. 1.0 = default (92 px half-width).
  // To widen further: raise TRACK_WIDTH_SCALE and ROAD_HALF_WIDTH together.
  TRACK_WIDTH_SCALE:       1.0,
  ROAD_HALF_WIDTH:         92,  // physical collision margin — now matches the visual render width
  TRACK_RENDER_HALF_WIDTH: 92,  // four visual lanes, each 46 px wide (sync with ROAD_HALF_WIDTH)
  TRACK_LENGTH_SCALE: 1.15,     // longer circuits without changing handling scale
  TRACK_LANE_COUNT: 4,
  CHECKPOINT_RADIUS: 105,       // radius to "pass" a checkpoint (scaled for 92 px road half-width)

  // Stage 6: Pickups & Boost Pads
  BOOST_PAD_FORCE:       260,   // forward velocity boost (px/s)
  POWERUP_STAR_MS: 5000,
  POWERUP_EMP_MS: 3500,
  POWERUP_EMP_FACTOR: 0.45,
  POWERUP_BOMB_DAMAGE: 32,
  POWERUP_BOMB_RADIUS: 120,
  POWERUP_LIGHTNING_DAMAGE: 18,
  POWERUP_LIGHTNING_RADIUS: 260,
  POWERUP_LIGHTNING_MS: 1800,
  POWERUP_BANANA_DAMAGE: 18,
  POWERUP_BANANA_SLOW_MS: 1600,
  POWERUP_ROCKET_DAMAGE: 28,
  POWERUP_ROCKET_LIFE_MS: 2800,
  POWERUP_FRENZY_MS: 5000,
  BOOST_PAD_DURATION_MS: 1200,  // boost effect duration
  BOOST_PAD_COOLDOWN_MS: 800,   // pad cooldown per car
  PICKUP_RADIUS:         24,    // pickup collection radius (px)
  PICKUP_RESPAWN_MS:     8000,  // pickup respawn time
  REPAIR_AMOUNT:         35,    // HP restored
  AMMO_RELOAD_RATIO:     0.5,   // 50% max ammo restored
  SHIELD_DURATION_MS:    6000,  // active shield duration
};

/* ─── Export ────────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined') {
  window.SHARED = SHARED;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SHARED;
}
