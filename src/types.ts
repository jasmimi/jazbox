export type GamePhase = "lobby" | "answering" | "voting" | "results" | "final";

export type Player = {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  joinedAt: number;
};

export type Prompt = {
  id: string;
  text: string;
};

export type Matchup = {
  id: string;
  promptId: string;
  playerIds: string[];
  answers: Record<string, string>;
  votes: Record<string, string>;
  scored: boolean;
};

export type RoomState = {
  roomCode: string;
  phase: GamePhase;
  players: Player[];
  matchups: Matchup[];
  currentMatchIndex: number;
  round: number;
  createdAt: number;
  updatedAt: number;
};

export type JoinRequestMessage = {
  type: "join_request";
  name: string;
};

export type SubmitAnswerMessage = {
  type: "submit_answer";
  matchId: string;
  answer: string;
};

export type SubmitVoteMessage = {
  type: "submit_vote";
  matchId: string;
  answerPlayerId: string;
};

export type PlayerClosedMessage = {
  type: "player_disconnect";
};

export type ClientToHostMessage =
  | JoinRequestMessage
  | SubmitAnswerMessage
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
