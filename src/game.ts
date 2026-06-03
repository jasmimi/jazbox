import type { Matchup, Player, Prompt, RoomState } from "./types";

const MAX_NAME_LENGTH = 18;
const MAX_ANSWER_LENGTH = 90;
const POINTS_PER_VOTE = 100;

type RandomSource = () => number;

export function sanitizeName(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : "Player";
}

export function sanitizeAnswer(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_LENGTH);
}

export function createRoomState(roomCode: string, now = Date.now()): RoomState {
  return {
    roomCode,
    phase: "lobby",
    players: [],
    matchups: [],
    currentMatchIndex: 0,
    round: 1,
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
  prompts: Prompt[],
  random: RandomSource = Math.random,
  now = Date.now()
): RoomState {
  const activePlayers = state.players.filter((player) => player.connected);

  if (activePlayers.length < 2) {
    throw new Error("At least two connected players are required.");
  }

  if (prompts.length === 0) {
    throw new Error("At least one prompt is required.");
  }

  return {
    ...state,
    phase: "answering",
    players: state.players.map((player) => ({ ...player, score: 0 })),
    matchups: createMatchups(activePlayers, prompts, random),
    currentMatchIndex: 0,
    updatedAt: now
  };
}

export function submitAnswer(
  state: RoomState,
  playerId: string,
  matchId: string,
  answer: string,
  now = Date.now()
): RoomState {
  const cleanAnswer = sanitizeAnswer(answer);
  const matchup = state.matchups.find((item) => item.id === matchId);

  if (state.phase !== "answering" || !matchup || !matchup.playerIds.includes(playerId) || !cleanAnswer) {
    return state;
  }

  return {
    ...state,
    matchups: state.matchups.map((item) =>
      item.id === matchId
        ? { ...item, answers: { ...item.answers, [playerId]: cleanAnswer } }
        : item
    ),
    updatedAt: now
  };
}

export function openVoting(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "answering" || state.matchups.length === 0) {
    return state;
  }

  return {
    ...state,
    phase: "voting",
    currentMatchIndex: 0,
    updatedAt: now
  };
}

export function submitVote(
  state: RoomState,
  voterId: string,
  matchId: string,
  answerPlayerId: string,
  now = Date.now()
): RoomState {
  const currentMatch = getCurrentMatchup(state);
  const answerOptions = getSubmittedAnswers(currentMatch);
  const canVote = answerOptions.some((option) => option.playerId !== voterId);

  if (
    state.phase !== "voting" ||
    !currentMatch ||
    currentMatch.id !== matchId ||
    answerPlayerId === voterId ||
    !canVote ||
    !answerOptions.some((option) => option.playerId === answerPlayerId)
  ) {
    return state;
  }

  return {
    ...state,
    matchups: state.matchups.map((item) =>
      item.id === matchId ? { ...item, votes: { ...item.votes, [voterId]: answerPlayerId } } : item
    ),
    updatedAt: now
  };
}

export function revealResults(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "voting") {
    return state;
  }

  const scored = scoreCurrentMatch(state);

  return {
    ...scored,
    phase: "results",
    updatedAt: now
  };
}

export function advanceFromResults(state: RoomState, now = Date.now()): RoomState {
  if (state.phase !== "results") {
    return state;
  }

  const nextIndex = state.currentMatchIndex + 1;

  if (nextIndex >= state.matchups.length) {
    return {
      ...state,
      phase: "final",
      updatedAt: now
    };
  }

  return {
    ...state,
    phase: "voting",
    currentMatchIndex: nextIndex,
    updatedAt: now
  };
}

export function returnToLobby(state: RoomState, now = Date.now()): RoomState {
  return {
    ...state,
    phase: "lobby",
    matchups: [],
    currentMatchIndex: 0,
    round: state.round + 1,
    players: state.players.map((player) => ({ ...player, score: 0 })),
    updatedAt: now
  };
}

export function getCurrentMatchup(state: RoomState): Matchup | undefined {
  return state.matchups[state.currentMatchIndex];
}

export function getPlayerMatchup(state: RoomState, playerId: string): Matchup | undefined {
  return state.matchups.find((matchup) => matchup.playerIds.includes(playerId));
}

export function getSubmittedAnswers(matchup: Matchup | undefined): Array<{ playerId: string; answer: string }> {
  if (!matchup) {
    return [];
  }

  return matchup.playerIds
    .map((playerId) => ({ playerId, answer: matchup.answers[playerId] }))
    .filter((item): item is { playerId: string; answer: string } => Boolean(item.answer));
}

export function getAnswerProgress(state: RoomState): { submitted: number; required: number } {
  const connectedPlayerIds = new Set(state.players.filter((player) => player.connected).map((player) => player.id));
  const requiredPlayerIds = new Set<string>();
  const submittedPlayerIds = new Set<string>();

  state.matchups.forEach((matchup) => {
    matchup.playerIds.forEach((playerId) => {
      if (connectedPlayerIds.has(playerId)) {
        requiredPlayerIds.add(playerId);
      }

      if (matchup.answers[playerId]) {
        submittedPlayerIds.add(playerId);
      }
    });
  });

  return {
    submitted: [...submittedPlayerIds].filter((playerId) => requiredPlayerIds.has(playerId)).length,
    required: requiredPlayerIds.size
  };
}

export function getEligibleVoterIds(state: RoomState, matchup: Matchup | undefined): string[] {
  const answerOptions = getSubmittedAnswers(matchup);

  return state.players
    .filter((player) => player.connected)
    .filter((player) => answerOptions.some((option) => option.playerId !== player.id))
    .map((player) => player.id);
}

export function getVoteProgress(
  state: RoomState,
  matchup: Matchup | undefined = getCurrentMatchup(state)
): { submitted: number; required: number } {
  const eligibleVoterIds = getEligibleVoterIds(state, matchup);
  const submitted = eligibleVoterIds.filter((playerId) => Boolean(matchup?.votes[playerId])).length;

  return {
    submitted,
    required: eligibleVoterIds.length
  };
}

export function getVoteTotals(matchup: Matchup | undefined): Record<string, number> {
  const totals: Record<string, number> = {};

  if (!matchup) {
    return totals;
  }

  matchup.playerIds.forEach((playerId) => {
    totals[playerId] = 0;
  });

  Object.values(matchup.votes).forEach((playerId) => {
    totals[playerId] = (totals[playerId] ?? 0) + 1;
  });

  return totals;
}

export function getPlayerName(state: RoomState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.name ?? "Player";
}

function createMatchups(players: Player[], prompts: Prompt[], random: RandomSource): Matchup[] {
  const shuffledPlayers = shuffle(players, random);
  const shuffledPrompts = shuffle(prompts, random);
  const groups: Player[][] = [];

  for (let index = 0; index < shuffledPlayers.length; index += 2) {
    groups.push(shuffledPlayers.slice(index, index + 2));
  }

  const lastGroup = groups[groups.length - 1];
  if (lastGroup.length === 1 && groups.length > 1) {
    groups[groups.length - 2] = [...groups[groups.length - 2], lastGroup[0]];
    groups.pop();
  }

  return groups.map((group, index) => {
    const prompt = shuffledPrompts[index % shuffledPrompts.length];

    return {
      id: `match-${index + 1}-${prompt.id}`,
      promptId: prompt.id,
      playerIds: group.map((player) => player.id),
      answers: {},
      votes: {},
      scored: false
    };
  });
}

function scoreCurrentMatch(state: RoomState): RoomState {
  const currentMatch = getCurrentMatchup(state);

  if (!currentMatch || currentMatch.scored) {
    return state;
  }

  const voteTotals = getVoteTotals(currentMatch);

  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      score: player.score + (voteTotals[player.id] ?? 0) * POINTS_PER_VOTE
    })),
    matchups: state.matchups.map((matchup) =>
      matchup.id === currentMatch.id ? { ...matchup, scored: true } : matchup
    )
  };
}

function shuffle<T>(items: T[], random: RandomSource): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[targetIndex]] = [copy[targetIndex], copy[index]];
  }

  return copy;
}
