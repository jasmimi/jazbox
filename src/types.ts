export type GamePhase = "lobby" | "acting" | "discussion" | "accusing" | "reveal" | "final";

export type ActionCategory = "pointing" | "numbers" | "hands" | "choice";

export type Player = {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  joinedAt: number;
};

export type ActionPrompt = {
  id: string;
  category: ActionCategory;
  text: string;
  fakerHint: string;
};

export type Round = {
  id: string;
  promptId: string;
  fakerId: string;
  playerIds: string[];
  readyPlayerIds: string[];
  votes: Record<string, string>;
  scored: boolean;
};

export type RoomState = {
  roomCode: string;
  phase: GamePhase;
  players: Player[];
  rounds: Round[];
  currentRoundIndex: number;
  round: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
};

export type JoinRequestMessage = {
  type: "join_request";
  name: string;
};

export type SubmitReadyMessage = {
  type: "submit_ready";
  roundId: string;
};

export type SubmitVoteMessage = {
  type: "submit_vote";
  roundId: string;
  suspectPlayerId: string;
};

export type PlayerClosedMessage = {
  type: "player_disconnect";
};

export type ClientToHostMessage =
  | JoinRequestMessage
  | SubmitReadyMessage
  | SubmitVoteMessage
  | PlayerClosedMessage;

export type JoinAcceptMessage = {
  type: "join_accept";
  playerId: string;
  state: RoomState;
};

export type JoinRejectMessage = {
  type: "join_reject";
  reason: string;
};

export type StateUpdateMessage = {
  type: "state_update";
  state: RoomState;
};

export type HostClosedMessage = {
  type: "host_closed";
};

export type HostToClientMessage =
  | JoinAcceptMessage
  | JoinRejectMessage
  | StateUpdateMessage
  | HostClosedMessage;
