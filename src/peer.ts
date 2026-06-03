const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 5;
const HOST_PEER_PREFIX = "jazbox-room-";

export function generateRoomCode(): string {
  let code = "";

  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[randomIndex];
  }

  return code;
}

export function normalizeRoomCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

export function roomCodeToPeerId(roomCode: string): string {
  return `${HOST_PEER_PREFIX}${normalizeRoomCode(roomCode).toLowerCase()}`;
}
