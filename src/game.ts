import type { ActionPrompt, Player, RoomState, Round } from "./types";

const MAX_NAME_LENGTH = 18;
const GROUP_CATCH_POINTS = 500;
const CORRECT_VOTE_POINTS = 250;
const FAKER_ESCAPE_POINTS = 800;
const FAKER_SPLIT_POINTS = 300;

export const MIN_PLAYERS = 3;
export const DEFAULT_ROUND_COUNT = 5;

type RandomSource = () => number;

export type RoundOutcome = {
  voteTotals: Record<string, number>;
  fakerVotes: number;
  topVotes: number;
  topPlayerIds: string[];
  voterCount: number;
  majorityThreshold: number;
  hasMajority: boolean;
  fakerCaught: boolean;
  splitVote: boolean;
};

export function sanitizeName(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : "Player";
}

export function createRoomState(
  roomCode: string,
  now = Date.now(),
  maxRounds = DEFAULT_ROUND_COUNT
): RoomState {
  return {
    roomCode,
    phase: "lobby",
    players: [],
    rounds: [],
    currentRoundIndex: 0,
    round: 1,
    maxRounds,
    createdAt: now,
    updatedAt: now
  };
}

export function addPlayer(state: RoomState, playerId: string, name: string, now = Date.now()): RoomState {
  const existing = state.players.find((player) => player.id === playerId);
  const cleanName = sanitizeName(name);
  const player: Player = {
    id: playerId,
    name: cleanName,
    score: existing?.score ?? 0,
    connected: true,
    joinedAt: existing?.joinedAt ?? now
  };

  return {
    ...state,
    players: [...state.players.filter((item) => item.id !== playerId), player],
    updatedAt: now
  };
}

export function markPlayerDisconnected(state: RoomState, playerId: string, now = Date.now()): RoomState {
  if (!state.players.some((player) => player.id === playerId && player.connected)) {
    return state;
  }

  return {
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, connected: false } : player
    ),
    updatedAt: now
  };
}

export function startGame(
  state: RoomState,
  prompts: ActionPrompt[],
  random: RandomSource = Math.random,
  now = Date.now()
): RoomState {
  const activePlayers = state.players.filter((player) => player.connected);

  if (activePlayers.length < MIN_PLAYERS) {
    throw new Error(`At least ${MIN_PLAYERS} connected players are required.`);
  }

  if (prompts.length === 0) {
    throw new Error("At least one prompt is required.");
  }

  return {
    ...state,
    phase: "acting",
    players: state.players.map((player) => ({ ...player, score: 0 })),
    rounds: createRounds(activePlayers, prompts, state.maxRounds, random),
    currentRoundIndex: 0,
    round: 1,
    updatedAt: now
  };
}

export function submitReady(
  state: RoomState,
  playerId: string,
  roundId: string,
  now = Date.now()
): RoomState {
  const currentRound = getCurrentRound(state);

  if (
    state.phase !== "acting" ||
    !currentRound ||
    currentRound.id !== roundId ||
    !currentRound.playerIds.includes(playerId) ||
    !isConnectedPlayer(state, playerId) ||
    currentRound.readyPlayerIds.includes(playerId)
  ) {
    return state;
  }

  return {
    ...state,
    rounds: state.rounds.map((round) =>
      round.id === roundId
        ? { ...round, readyPlayerIds: [...round.readyPlayerIds, playerId] }
        : round
    ),
    updatedAt: now
  };
}

export function openDiscussion(state: RoomState, now = Date.now()): RoomState {
  const progress = getReadyProgress(state);

  if (state.phase !== "acting" || progress.required === 0 || progress.submitted < progress.required) {
    return state;
  }

  return {
    ...state,
    phase: "discussion",
    updatedAt: now
  };
}

export function openAccusation(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "discussion" || !getCurrentRound(state)) {
    return state;
  }

  return {
    ...state,
    phase: "accusing",
    updatedAt: now
  };
}

export function submitVote(
  state: RoomState,
  voterId: string,
  roundId: string,
  suspectPlayerId: string,
  now = Date.now()
): RoomState {
  const currentRound = getCurrentRound(state);
  const eligibleVoterIds = getEligibleVoterIds(state, currentRound);

  if (
    state.phase !== "accusing" ||
    !currentRound ||
    currentRound.id !== roundId ||
    voterId === suspectPlayerId ||
    !eligibleVoterIds.includes(voterId) ||
    !currentRound.playerIds.includes(suspectPlayerId)
  ) {
    return state;
  }

  return {
    ...state,
    rounds: state.rounds.map((round) =>
      round.id === roundId ? { ...round, votes: { ...round.votes, [voterId]: suspectPlayerId } } : round
    ),
    updatedAt: now
  };
}

export function revealResults(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "accusing") {
    return state;
  }

  const scored = scoreCurrentRound(state);

  return {
    ...scored,
    phase: "reveal",
    updatedAt: now
  };
}

export function advanceFromReveal(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "reveal") {
    return state;
  }

  const nextIndex = state.currentRoundIndex + 1;

  if (nextIndex >= state.rounds.length) {
    return {
      ...state,
      phase: "final",
      updatedAt: now
    };
  }

  return {
    ...state,
    phase: "acting",
    currentRoundIndex: nextIndex,
    round: nextIndex + 1,
    updatedAt: now
  };
}

export function returnToLobby(state: RoomState, now = Date.now()): RoomState {
  return {
    ...state,
    phase: "lobby",
    rounds: [],
    currentRoundIndex: 0,
    round: 1,
    players: state.players.map((player) => ({ ...player, score: 0 })),
    updatedAt: now
  };
}

export function getCurrentRound(state: RoomState): Round | undefined {
  return state.rounds[state.currentRoundIndex];
}

export function getReadyProgress(
  state: RoomState,
  round: Round | undefined = getCurrentRound(state)
): { submitted: number; required: number } {
  const requiredPlayerIds = getConnectedRoundPlayerIds(state, round);
  const submitted = requiredPlayerIds.filter((playerId) => Boolean(round?.readyPlayerIds.includes(playerId))).length;

  return {
    submitted,
    required: requiredPlayerIds.length
  };
}

export function getEligibleVoterIds(state: RoomState, round: Round | undefined = getCurrentRound(state)): string[] {
  return getConnectedRoundPlayerIds(state, round);
}

export function getVoteProgress(
  state: RoomState,
  round: Round | undefined = getCurrentRound(state)
): { submitted: number; required: number } {
  const eligibleVoterIds = getEligibleVoterIds(state, round);
  const submitted = eligibleVoterIds.filter((playerId) => Boolean(round?.votes[playerId])).length;

  return {
    submitted,
    required: eligibleVoterIds.length
  };
}

export function getVoteTotals(round: Round | undefined): Record<string, number> {
  const totals: Record<string, number> = {};

  if (!round) {
    return totals;
  }

  round.playerIds.forEach((playerId) => {
    totals[playerId] = 0;
  });

  Object.values(round.votes).forEach((playerId) => {
    totals[playerId] = (totals[playerId] ?? 0) + 1;
  });

  return totals;
}

export function getRoundOutcome(round: Round | undefined): RoundOutcome {
  const voteTotals = getVoteTotals(round);
  const voterCount = round ? Object.keys(round.votes).length : 0;
  const topVotes = Math.max(0, ...Object.values(voteTotals));
  const topPlayerIds = Object.entries(voteTotals)
    .filter(([, total]) => total === topVotes && total > 0)
    .map(([playerId]) => playerId);
  const majorityThreshold = Math.floor(voterCount / 2) + 1;
  const fakerVotes = round ? voteTotals[round.fakerId] ?? 0 : 0;
  const hasMajority = topVotes >= majorityThreshold;
  const fakerCaught = Boolean(round && fakerVotes > 0 && fakerVotes === topVotes && topPlayerIds.length === 1);

  return {
    voteTotals,
    fakerVotes,
    topVotes,
    topPlayerIds,
    voterCount,
    majorityThreshold,
    hasMajority,
    fakerCaught,
    splitVote: !hasMajority || topPlayerIds.length > 1
  };
}

export function getPlayerName(state: RoomState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.name ?? "Player";
}

function createRounds(
  players: Player[],
  prompts: ActionPrompt[],
  roundCount: number,
  random: RandomSource
): Round[] {
  const shuffledPlayers = shuffle(players, random);
  const shuffledPrompts = shuffle(prompts, random);
  const playerIds = players.map((player) => player.id);

  return Array.from({ length: Math.max(1, roundCount) }, (_, index) => {
    const prompt = shuffledPrompts[index % shuffledPrompts.length];
    const faker = shuffledPlayers[index % shuffledPlayers.length];

    return {
      id: `round-${index + 1}-${prompt.id}`,
      promptId: prompt.id,
      fakerId: faker.id,
      playerIds,
      readyPlayerIds: [],
      votes: {},
      scored: false
    };
  });
}

function scoreCurrentRound(state: RoomState): RoomState {
  const currentRound = getCurrentRound(state);

  if (!currentRound || currentRound.scored) {
    return state;
  }

  const outcome = getRoundOutcome(currentRound);

  return {
    ...state,
    players: state.players.map((player) => {
      if (!currentRound.playerIds.includes(player.id)) {
        return player;
      }

      const votedForFaker = currentRound.votes[player.id] === currentRound.fakerId;
      const isFaker = player.id === currentRound.fakerId;
      let score = player.score;

      if (isFaker) {
        if (!outcome.fakerCaught) {
          score += FAKER_ESCAPE_POINTS;
        }

        if (!outcome.fakerCaught && outcome.splitVote) {
          score += FAKER_SPLIT_POINTS;
        }
      } else {
        if (outcome.fakerCaught) {
          score += GROUP_CATCH_POINTS;
        }

        if (votedForFaker) {
          score += CORRECT_VOTE_POINTS;
        }
      }

      return { ...player, score };
    }),
    rounds: state.rounds.map((round) =>
      round.id === currentRound.id ? { ...round, scored: true } : round
    )
  };
}

function getConnectedRoundPlayerIds(state: RoomState, round: Round | undefined): string[] {
  if (!round) {
    return [];
  }

  const connectedPlayerIds = new Set(state.players.filter((player) => player.connected).map((player) => player.id));

  return round.playerIds.filter((playerId) => connectedPlayerIds.has(playerId));
}

function isConnectedPlayer(state: RoomState, playerId: string): boolean {
  return state.players.some((player) => player.id === playerId && player.connected);
}

function shuffle<T>(items: T[], random: RandomSource): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[targetIndex]] = [copy[targetIndex], copy[index]];
  }

  return copy;
}
