import { describe, expect, it } from "vitest";
import {
  addPlayer,
  advanceFromReveal,
  createRoomState,
  getCurrentRound,
  getReadyProgress,
  getRoundOutcome,
  getVoteProgress,
  markPlayerDisconnected,
  openAccusation,
  openDiscussion,
  revealResults,
  startGame,
  submitReady,
  submitVote
} from "./game";
import type { ActionPrompt, RoomState } from "./types";

const prompts: ActionPrompt[] = [
  {
    id: "prompt-a",
    category: "pointing",
    text: "Point at Player A.",
    fakerHint: "Blend in. Everyone is pointing."
  },
  {
    id: "prompt-b",
    category: "numbers",
    text: "Hold up a number.",
    fakerHint: "Blend in. Everyone is showing a number."
  }
];

const stableRandom = () => 0;

function roomWithPlayers(count: number, maxRounds = 5): RoomState {
  let state = createRoomState("ABCDE", 1, maxRounds);

  for (let index = 1; index <= count; index += 1) {
    state = addPlayer(state, `player-${index}`, `Player ${index}`, index + 1);
  }

  return state;
}

function moveToAccusation(state: RoomState): RoomState {
  const round = getCurrentRound(state);

  expect(round).toBeDefined();

  for (const playerId of round?.playerIds ?? []) {
    state = submitReady(state, playerId, round?.id ?? "", 20);
  }

  state = openDiscussion(state, 21);
  state = openAccusation(state, 22);

  return state;
}

function voteToCatchFaker(state: RoomState): RoomState {
  const round = getCurrentRound(state);
  const fallbackSuspect = round?.playerIds.find((playerId) => playerId !== round.fakerId) ?? "";

  expect(round).toBeDefined();

  for (const voterId of round?.playerIds ?? []) {
    state = submitVote(
      state,
      voterId,
      round?.id ?? "",
      voterId === round?.fakerId ? fallbackSuspect : round?.fakerId ?? "",
      30
    );
  }

  return state;
}

describe("faker game flow", () => {
  it("requires at least three connected players", () => {
    expect(() => startGame(roomWithPlayers(2), prompts, stableRandom, 10)).toThrow(
      "At least 3 connected players are required."
    );
  });

  it("creates hidden-faker rounds and rotates fakers before repeating", () => {
    const state = startGame(roomWithPlayers(4, 5), prompts, stableRandom, 10);

    expect(state.phase).toBe("acting");
    expect(state.rounds).toHaveLength(5);
    expect(state.rounds[0].playerIds).toHaveLength(4);
    expect(new Set(state.rounds.slice(0, 4).map((round) => round.fakerId)).size).toBe(4);
    expect(state.rounds.every((round) => round.fakerId && round.playerIds.includes(round.fakerId))).toBe(true);
  });

  it("tracks ready progress for connected round players only", () => {
    let state = startGame(roomWithPlayers(3), prompts, stableRandom, 10);
    const round = getCurrentRound(state);
    const [firstPlayer, secondPlayer, thirdPlayer] = round?.playerIds ?? [];

    expect(getReadyProgress(state)).toEqual({ submitted: 0, required: 3 });

    state = submitReady(state, firstPlayer, round?.id ?? "", 11);
    state = markPlayerDisconnected(state, thirdPlayer, 12);

    expect(getReadyProgress(state)).toEqual({ submitted: 1, required: 2 });
    expect(openDiscussion(state, 13).phase).toBe("acting");

    state = submitReady(state, secondPlayer, round?.id ?? "", 14);
    state = openDiscussion(state, 15);

    expect(state.phase).toBe("discussion");
  });

  it("rejects self-votes and tracks accusation progress", () => {
    let state = moveToAccusation(startGame(roomWithPlayers(3), prompts, stableRandom, 10));
    const round = getCurrentRound(state);
    const [firstPlayer, secondPlayer] = round?.playerIds ?? [];

    state = submitVote(state, firstPlayer, round?.id ?? "", firstPlayer, 23);

    expect(getVoteProgress(state, getCurrentRound(state))).toEqual({ submitted: 0, required: 3 });

    state = submitVote(state, firstPlayer, round?.id ?? "", secondPlayer, 24);

    expect(getVoteProgress(state, getCurrentRound(state))).toEqual({ submitted: 1, required: 3 });
    expect(getCurrentRound(state)?.votes[firstPlayer]).toBe(secondPlayer);
  });

  it("scores a caught faker once", () => {
    let state = moveToAccusation(startGame(roomWithPlayers(3), prompts, stableRandom, 10));
    const round = getCurrentRound(state);
    const nonFakerIds = round?.playerIds.filter((playerId) => playerId !== round.fakerId) ?? [];

    state = voteToCatchFaker(state);

    expect(getRoundOutcome(getCurrentRound(state)).fakerCaught).toBe(true);

    state = revealResults(state, 40);
    state = revealResults(state, 41);

    expect(state.players.find((player) => player.id === round?.fakerId)?.score).toBe(0);
    nonFakerIds.forEach((playerId) => {
      expect(state.players.find((player) => player.id === playerId)?.score).toBe(750);
    });
  });

  it("scores faker survival with a split bonus while rewarding correct voters", () => {
    let state = moveToAccusation(startGame(roomWithPlayers(4), prompts, stableRandom, 10));
    const round = getCurrentRound(state);
    const nonFakerIds = round?.playerIds.filter((playerId) => playerId !== round.fakerId) ?? [];

    expect(round).toBeDefined();
    expect(nonFakerIds).toHaveLength(3);

    state = submitVote(state, nonFakerIds[0], round?.id ?? "", round?.fakerId ?? "", 30);
    state = submitVote(state, nonFakerIds[1], round?.id ?? "", nonFakerIds[2], 31);
    state = submitVote(state, nonFakerIds[2], round?.id ?? "", nonFakerIds[1], 32);
    state = submitVote(state, round?.fakerId ?? "", round?.id ?? "", nonFakerIds[1], 33);

    const outcome = getRoundOutcome(getCurrentRound(state));
    expect(outcome.fakerCaught).toBe(false);
    expect(outcome.splitVote).toBe(true);

    state = revealResults(state, 34);

    expect(state.players.find((player) => player.id === round?.fakerId)?.score).toBe(1100);
    expect(state.players.find((player) => player.id === nonFakerIds[0])?.score).toBe(250);
  });

  it("advances to final after the configured round count", () => {
    let state = moveToAccusation(startGame(roomWithPlayers(3, 1), prompts, stableRandom, 10));

    state = voteToCatchFaker(state);
    state = revealResults(state, 40);
    state = advanceFromReveal(state, 41);

    expect(state.phase).toBe("final");
  });
});
