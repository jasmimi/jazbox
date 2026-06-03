import { describe, expect, it } from "vitest";
import {
  addPlayer,
  advanceFromResults,
  createRoomState,
  getAnswerProgress,
  getCurrentMatchup,
  getEligibleVoterIds,
  getVoteProgress,
  getVoteTotals,
  openVoting,
  revealResults,
  startGame,
  submitAnswer,
  submitVote
} from "./game";
import type { Prompt, RoomState } from "./types";

const prompts: Prompt[] = [
  { id: "prompt-a", text: "Prompt A" },
  { id: "prompt-b", text: "Prompt B" }
];

const stableRandom = () => 0;

function roomWithPlayers(count: number): RoomState {
  let state = createRoomState("ABCDE", 1);

  for (let index = 1; index <= count; index += 1) {
    state = addPlayer(state, `player-${index}`, `Player ${index}`, index + 1);
  }

  return state;
}

describe("game flow", () => {
  it("assigns connected players into prompt matchups", () => {
    const state = startGame(roomWithPlayers(5), prompts, stableRandom, 10);

    expect(state.phase).toBe("answering");
    expect(state.matchups).toHaveLength(2);
    expect(state.matchups.flatMap((matchup) => matchup.playerIds)).toHaveLength(5);
    expect(state.matchups.some((matchup) => matchup.playerIds.length === 3)).toBe(true);
  });

  it("tracks answer progress for connected players", () => {
    let state = startGame(roomWithPlayers(2), prompts, stableRandom, 10);
    const matchup = getCurrentMatchup(state);

    expect(matchup).toBeDefined();
    expect(getAnswerProgress(state)).toEqual({ submitted: 0, required: 2 });

    state = submitAnswer(state, matchup?.playerIds[0] ?? "", matchup?.id ?? "", "a good line", 11);

    expect(getAnswerProgress(state)).toEqual({ submitted: 1, required: 2 });
  });

  it("counts votes and scores the current match once", () => {
    let state = startGame(roomWithPlayers(3), prompts, stableRandom, 10);
    const matchup = getCurrentMatchup(state);
    const [firstPlayer, secondPlayer, thirdPlayer] = matchup?.playerIds ?? [];

    state = submitAnswer(state, firstPlayer, matchup?.id ?? "", "first", 11);
    state = submitAnswer(state, secondPlayer, matchup?.id ?? "", "second", 12);
    state = submitAnswer(state, thirdPlayer, matchup?.id ?? "", "third", 13);
    state = openVoting(state, 14);

    expect(getEligibleVoterIds(state, getCurrentMatchup(state))).toHaveLength(3);

    state = submitVote(state, firstPlayer, matchup?.id ?? "", secondPlayer, 15);
    state = submitVote(state, secondPlayer, matchup?.id ?? "", firstPlayer, 16);
    state = submitVote(state, thirdPlayer, matchup?.id ?? "", secondPlayer, 17);

    expect(getVoteProgress(state, getCurrentMatchup(state))).toEqual({ submitted: 3, required: 3 });
    expect(getVoteTotals(getCurrentMatchup(state))).toMatchObject({ [secondPlayer]: 2, [firstPlayer]: 1 });

    state = revealResults(state, 18);
    state = revealResults(state, 19);

    expect(state.players.find((player) => player.id === secondPlayer)?.score).toBe(200);
    expect(state.players.find((player) => player.id === firstPlayer)?.score).toBe(100);
  });

  it("advances from results to final after the last matchup", () => {
    let state = startGame(roomWithPlayers(2), prompts, stableRandom, 10);
    const matchup = getCurrentMatchup(state);

    state = submitAnswer(state, matchup?.playerIds[0] ?? "", matchup?.id ?? "", "first", 11);
    state = submitAnswer(state, matchup?.playerIds[1] ?? "", matchup?.id ?? "", "second", 12);
    state = openVoting(state, 13);
    state = revealResults(state, 14);
    state = advanceFromResults(state, 15);

    expect(state.phase).toBe("final");
  });
});
