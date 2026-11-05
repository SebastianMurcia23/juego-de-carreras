/**
 * tools/verify-return-to-lobby.js
 * Validates that an admin/host can abort an in-progress race and return
 * all players back to the lobby to re-select vehicles without kicking anyone.
 */
'use strict';

const assert = require('assert');
const RoomManager = require('../server/RoomManager');
const SHARED = require('../shared/constants');

// Mock Socket.IO server
function createMockIO() {
  const emittedEvents = [];
  return {
    emittedEvents,
    sockets: {
      sockets: new Map(),
    },
    to(roomCode) {
      return {
        emit(event, data) {
          emittedEvents.push({ roomCode, event, data });
        },
      };
    },
    emit(event, data) {
      emittedEvents.push({ event, data });
    },
  };
}

async function runTest() {
  console.log('\uD83E\uDDEA Starting Return to Lobby Verification Test...');

  const io = createMockIO();
  const rooms = new RoomManager(io);

  // 1. Create a room (host)
  const hostRes = await rooms.createRoom('host-socket-1');
  const roomCode       = hostRes.roomCode;
  const hostToken      = hostRes.hostToken;
  const hostSeatToken  = hostRes.seatToken;

  // 2. Get room reference
  const room = rooms.rooms.get(roomCode);
  assert(room, 'Room must exist after createRoom');

  // 3. Set host name directly (createRoom does not auto-set a name)
  room.seats.get(hostSeatToken).name = 'Host Pilot';

  // 4. Add two guest players and set their names
  const guestRes = await rooms.joinRoom(roomCode, 'guest-socket-2');
  const guestSeatToken = guestRes.seatToken;
  room.seats.get(guestSeatToken).name = 'Guest Pilot';

  const guest2Res = await rooms.joinRoom(roomCode, 'guest-socket-3');
  const guest2SeatToken = guest2Res.seatToken;
  room.seats.get(guest2SeatToken).name = 'Guest 2';

  assert.strictEqual(room.seats.size, 3, 'Room must have 3 seats connected');

  // 5. Start the game
  const startRes = rooms.startGame(roomCode, hostToken);
  if (startRes.error) {
    console.error('startGame error:', startRes);
  }
  assert(!startRes.error, `Game should start cleanly (got: ${startRes.error})`);
  assert.strictEqual(room.state, SHARED.STATES.ROOM.RACING, 'Room state should be RACING');
  assert(room.gameRoom, 'GameRoom physics instance must be active');

  // Check all players were marked ready
  for (const [, seat] of room.seats) {
    assert.strictEqual(seat.isReady, true, `Seat "${seat.name}" must be ready during race`);
  }

  // 6. Unauthorized return attempt (fake token) must be rejected
  const unauthRes = rooms.returnToLobby(roomCode, 'fake-token-123');
  assert.strictEqual(unauthRes.error, 'UNAUTHORIZED', 'Unauthorized attempt must be rejected');
  assert(room.gameRoom, 'GameRoom must still be running after unauthorized attempt');

  // 7. Host invokes returnToLobby via hostToken (computer screen path)
  const returnRes = rooms.returnToLobby(roomCode, hostToken);
  assert.strictEqual(returnRes.success, true, 'Host returnToLobby must succeed');

  // 8. Verify room state after returning to lobby
  assert.strictEqual(room.state, SHARED.STATES.ROOM.LOBBY, 'Room state must be LOBBY');
  assert.strictEqual(room.gameRoom, null, 'GameRoom must be stopped and cleared');
  assert.strictEqual(room.seats.size, 3, 'No players should be kicked (3/3 seats retained)');

  // Championship must be fully reset so a new run can begin fresh
  if (room.championship) {
    assert.strictEqual(room.championship.raceNumber, 0, 'championship.raceNumber must reset to 0');
    assert.strictEqual(room.championship.standings.size, 0, 'championship.standings must be cleared');
  }

  for (const [, seat] of room.seats) {
    assert.strictEqual(seat.isReady, false, `Seat "${seat.name}" must have isReady=false`);
    const validState = seat.state === SHARED.STATES.SEAT.SELECTING ||
                       seat.state === SHARED.STATES.SEAT.LINKED;
    assert(validState, `Seat "${seat.name}" state must be SELECTING or LINKED, got: ${seat.state}`);
  }

  // 9. Verify RETURN_TO_LOBBY event was broadcast to the room
  const returnEvent = io.emittedEvents.find(
    e => e.event === SHARED.EVENTS.RETURN_TO_LOBBY && e.roomCode === roomCode
  );
  assert(returnEvent, 'RETURN_TO_LOBBY event must be emitted to the room');

  // 10. Test that a player can change their car and toggle ready (from screen)
  const guestSeat = room.seats.get(guestSeatToken);
  const changeRes = rooms.selectLoadout(guestSeatToken, 'cyber_storm', null, 'Guest Storm', 'guest-socket-2');
  assert(!changeRes.error, `selectLoadout from screen must succeed (got: ${changeRes.error})`);
  assert.strictEqual(guestSeat.carId, 'cyber_storm', 'Guest car must be updated to cyber_storm');

  // 11. Re-start game and verify new game starts from scratch at starting grid
  const restart = rooms.startGame(roomCode, hostToken);
  assert(!restart.error, `Game must restart cleanly (got: ${restart.error})`);
  assert(room.gameRoom, 'GameRoom must be active for restart test');

  // Verify guest car is at starting grid, not wherever it left off
  const newGuestCar = room.gameRoom.cars.get(guestSeatToken);
  assert(newGuestCar, 'Guest car state must exist in new GameRoom');
  assert.strictEqual(newGuestCar.carId, 'cyber_storm', 'New GameRoom must use updated car');
  assert.strictEqual(newGuestCar.lap, 0, 'Car lap must reset to 0');
  assert.strictEqual(newGuestCar.currentCP, 0, 'Car currentCP must reset to 0');
  assert.strictEqual(newGuestCar.speed, 0, 'Car speed must start at 0');

  // 12. Mobile controller abort via hostSeatToken
  const hostSeat = room.seats.get(hostSeatToken);
  hostSeat.mobileSocketId = 'mobile-socket-host';
  const mobileAbortRes = rooms.returnToLobby(roomCode, null, hostSeatToken);
  assert.strictEqual(mobileAbortRes.success, true, 'Host mobile controller must be able to return to lobby');
  assert.strictEqual(room.state, SHARED.STATES.ROOM.LOBBY, 'Room state must return to LOBBY via mobile');
  assert.strictEqual(room.gameRoom, null, 'GameRoom must be cleared via mobile abort');
  assert.strictEqual(room.seats.size, 3, 'All 3 players still retained after mobile abort');

  console.log('\uD83C\uDF89 ALL RETURN TO LOBBY UNIT TESTS PASSED SUCCESSFULLY!');
}

runTest().catch((err) => {
  console.error('\u274C Test failed:', err.message || err);
  process.exit(1);
});
