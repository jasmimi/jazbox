import { useCallback, useMemo, useRef, useState } from "react";
import Peer, { DataConnection } from "peerjs";
import {
  addPlayer,
  advanceFromResults,
  createRoomState,
  getAnswerProgress,
  getCurrentMatchup,
  getEligibleVoterIds,
  getPlayerMatchup,
  getPlayerName,
  getSubmittedAnswers,
  getVoteProgress,
  getVoteTotals,
  markPlayerDisconnected,
  openVoting,
  returnToLobby,
  revealResults,
  sanitizeName,
  startGame,
  submitAnswer,
  submitVote
} from "./game";
import { normalizeRoomCode, generateRoomCode, roomCodeToPeerId } from "./peer";
import { PROMPTS } from "./prompts";
import type { ClientToHostMessage, HostToClientMessage, Matchup, RoomState } from "./types";

type AppMode = "home" | "host" | "player";
type ConnectionState = "idle" | "connecting" | "ready" | "error" | "closed";

const ROOM_RETRY_LIMIT = 8;

function App() {
  const initialRoomCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return normalizeRoomCode(params.get("room") ?? "");
  }, []);

  const [mode, setMode] = useState<AppMode>("home");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [hostStatus, setHostStatus] = useState("Ready to roll");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState(initialRoomCode);
  const [playerId, setPlayerId] = useState("");
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const roomRef = useRef<RoomState | null>(null);
  const hostPeerRef = useRef<Peer | null>(null);
  const playerPeerRef = useRef<Peer | null>(null);
  const playerConnectionRef = useRef<DataConnection | null>(null);
  const hostConnectionsRef = useRef<Map<string, DataConnection>>(new Map());

  const promptById = useMemo(() => new Map(PROMPTS.map((prompt) => [prompt.id, prompt])), []);

  const commitHostState = useCallback((nextState: RoomState) => {
    roomRef.current = nextState;
    setRoomState(nextState);

    const message: HostToClientMessage = { type: "state_update", state: nextState };
    hostConnectionsRef.current.forEach((connection) => {
      if (connection.open) {
        connection.send(message);
      }
    });
  }, []);

  const shutdownHost = useCallback(() => {
    const message: HostToClientMessage = { type: "host_closed" };
    hostConnectionsRef.current.forEach((connection) => {
      if (connection.open) {
        connection.send(message);
        connection.close();
      }
    });
    hostConnectionsRef.current.clear();
    hostPeerRef.current?.destroy();
    hostPeerRef.current = null;
  }, []);

  const shutdownPlayer = useCallback(() => {
    const message: ClientToHostMessage = { type: "player_disconnect" };
    if (playerConnectionRef.current?.open) {
      playerConnectionRef.current.send(message);
    }
    playerConnectionRef.current?.close();
    playerConnectionRef.current = null;
    playerPeerRef.current?.destroy();
    playerPeerRef.current = null;
  }, []);

  const goHome = useCallback(() => {
    shutdownHost();
    shutdownPlayer();
    setMode("home");
    setRoomState(null);
    roomRef.current = null;
    setPlayerId("");
    setConnectionState("idle");
    setHostStatus("Ready to roll");
  }, [shutdownHost, shutdownPlayer]);

  const handleHostMessage = useCallback(
    (connection: DataConnection, message: ClientToHostMessage) => {
      const currentState = roomRef.current;

      if (!currentState) {
        return;
      }

      if (message.type === "join_request") {
        if (currentState.phase !== "lobby") {
          connection.send({ type: "join_reject", reason: "This round is already in motion." });
          return;
        }

        hostConnectionsRef.current.set(connection.peer, connection);
        const nextState = addPlayer(currentState, connection.peer, message.name);
        connection.send({ type: "join_accept", playerId: connection.peer, state: nextState });
        commitHostState(nextState);
        return;
      }

      const knownPlayer = currentState.players.some((player) => player.id === connection.peer);
      if (!knownPlayer) {
        return;
      }

      if (message.type === "submit_answer") {
        commitHostState(submitAnswer(currentState, connection.peer, message.matchId, message.answer));
      }

      if (message.type === "submit_vote") {
        commitHostState(submitVote(currentState, connection.peer, message.matchId, message.answerPlayerId));
      }

      if (message.type === "player_disconnect") {
        commitHostState(markPlayerDisconnected(currentState, connection.peer));
      }
    },
    [commitHostState]
  );

  const setupHostConnection = useCallback(
    (connection: DataConnection) => {
      connection.on("data", (message) => handleHostMessage(connection, message as ClientToHostMessage));
      connection.on("close", () => {
        hostConnectionsRef.current.delete(connection.peer);
        const currentState = roomRef.current;

        if (currentState?.players.some((player) => player.id === connection.peer && player.connected)) {
          commitHostState(markPlayerDisconnected(currentState, connection.peer));
        }
      });
    },
    [commitHostState, handleHostMessage]
  );

  const createHostPeer = useCallback(
    (attempt = 0) => {
      const roomCode = generateRoomCode();
      const peer = new Peer(roomCodeToPeerId(roomCode));
      hostPeerRef.current = peer;
      setHostStatus("Opening room");
      setConnectionState("connecting");

      peer.on("open", () => {
        const nextState = createRoomState(roomCode);
        roomRef.current = nextState;
        setRoomState(nextState);
        setHostStatus("Room live");
        setConnectionState("ready");
      });

      peer.on("connection", setupHostConnection);

      peer.on("error", (error) => {
        peer.destroy();

        if (error.type === "unavailable-id" && attempt < ROOM_RETRY_LIMIT) {
          createHostPeer(attempt + 1);
          return;
        }

        setHostStatus(error.message || "Could not open room");
        setConnectionState("error");
      });
    },
    [setupHostConnection]
  );

  const startHosting = () => {
    shutdownPlayer();
    shutdownHost();
    setMode("host");
    setRoomState(null);
    createHostPeer();
  };

  const joinRoom = () => {
    const cleanName = sanitizeName(joinName);
    const cleanCode = normalizeRoomCode(joinCode);

    if (!cleanCode) {
      setConnectionState("error");
      return;
    }

    shutdownHost();
    shutdownPlayer();
    setConnectionState("connecting");
    setMode("player");
    setJoinName(cleanName);
    setJoinCode(cleanCode);

    const peer = new Peer();
    playerPeerRef.current = peer;

    peer.on("open", () => {
      const connection = peer.connect(roomCodeToPeerId(cleanCode), { reliable: true });
      playerConnectionRef.current = connection;

      connection.on("open", () => {
        connection.send({ type: "join_request", name: cleanName } satisfies ClientToHostMessage);
      });

      connection.on("data", (rawMessage) => {
        const message = rawMessage as HostToClientMessage;

        if (message.type === "join_accept") {
          setPlayerId(message.playerId);
          setRoomState(message.state);
          setConnectionState("ready");
        }

        if (message.type === "join_reject") {
          setHostStatus(message.reason);
          setConnectionState("error");
        }

        if (message.type === "state_update") {
          setRoomState(message.state);
        }

        if (message.type === "host_closed") {
          setConnectionState("closed");
        }
      });

      connection.on("close", () => {
        setConnectionState((current) => (current === "ready" ? "closed" : current));
      });

      connection.on("error", (error) => {
        setHostStatus(error.message || "Connection failed");
        setConnectionState("error");
      });
    });

    peer.on("error", (error) => {
      setHostStatus(error.message || "Connection failed");
      setConnectionState("error");
    });
  };

  const sendPlayerMessage = (message: ClientToHostMessage) => {
    if (playerConnectionRef.current?.open) {
      playerConnectionRef.current.send(message);
    }
  };

  const hostStartGame = () => {
    if (!roomRef.current) {
      return;
    }

    try {
      commitHostState(startGame(roomRef.current, PROMPTS));
    } catch (error) {
      setHostStatus(error instanceof Error ? error.message : "Could not start");
    }
  };

  const hostOpenVoting = () => {
    if (roomRef.current) {
      commitHostState(openVoting(roomRef.current));
    }
  };

  const hostRevealResults = () => {
    if (roomRef.current) {
      commitHostState(revealResults(roomRef.current));
    }
  };

  const hostAdvance = () => {
    if (roomRef.current) {
      commitHostState(advanceFromResults(roomRef.current));
    }
  };

  const hostReturnToLobby = () => {
    if (roomRef.current) {
      commitHostState(returnToLobby(roomRef.current));
    }
  };

  const copyJoinLink = async () => {
    if (!roomState) {
      return;
    }

    const url = new URL(window.location.href);
    url.search = `?room=${roomState.roomCode}`;

    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className={`app mode-${mode}`}>
      <div className="stage-lights" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="app-shell">
        {mode === "home" && (
          <HomeScreen
            joinCode={joinCode}
            joinName={joinName}
            onCreateRoom={startHosting}
            onJoinCodeChange={setJoinCode}
            onJoinNameChange={setJoinName}
            onJoinRoom={joinRoom}
          />
        )}

        {mode === "host" && (
          <HostScreen
            copied={copied}
            connectionState={connectionState}
            hostStatus={hostStatus}
            promptById={promptById}
            roomState={roomState}
            onAdvance={hostAdvance}
            onCopyLink={copyJoinLink}
            onGoHome={goHome}
            onOpenVoting={hostOpenVoting}
            onReturnToLobby={hostReturnToLobby}
            onRevealResults={hostRevealResults}
            onStartGame={hostStartGame}
          />
        )}

        {mode === "player" && (
          <PlayerScreen
            answerDrafts={answerDrafts}
            connectionState={connectionState}
            hostStatus={hostStatus}
            playerId={playerId}
            promptById={promptById}
            roomState={roomState}
            onAnswerDraftChange={setAnswerDrafts}
            onGoHome={goHome}
            onSend={sendPlayerMessage}
          />
        )}
      </div>
    </main>
  );
}

type HomeScreenProps = {
  joinCode: string;
  joinName: string;
  onCreateRoom: () => void;
  onJoinCodeChange: (value: string) => void;
  onJoinNameChange: (value: string) => void;
  onJoinRoom: () => void;
};

function HomeScreen({
  joinCode,
  joinName,
  onCreateRoom,
  onJoinCodeChange,
  onJoinNameChange,
  onJoinRoom
}: HomeScreenProps) {
  return (
    <section className="home-screen">
      <div className="brand-lockup">
        <h1>JazBox</h1>
      </div>

      <div className="home-actions">
        <div className="show-panel host-panel">
          <div>
            <p className="panel-kicker">Big screen</p>
            <h2>Host a room</h2>
          </div>
          <button className="button button-primary" type="button" onClick={onCreateRoom}>
            Create Room
          </button>
        </div>

        <form
          className="show-panel join-panel"
          onSubmit={(event) => {
            event.preventDefault();
            onJoinRoom();
          }}
        >
          <div>
            <p className="panel-kicker">Phone players</p>
            <h2>Join the game</h2>
          </div>
          <label>
            <span>Name</span>
            <input
              autoComplete="nickname"
              maxLength={18}
              onChange={(event) => onJoinNameChange(event.target.value)}
              placeholder="Mabel"
              value={joinName}
            />
          </label>
          <label>
            <span>Room code</span>
            <input
              autoCapitalize="characters"
              autoComplete="off"
              className="room-input"
              inputMode="text"
              maxLength={5}
              onChange={(event) => onJoinCodeChange(normalizeRoomCode(event.target.value))}
              placeholder="AB12C"
              value={joinCode}
            />
          </label>
          <button className="button button-secondary" type="submit">
            Join Room
          </button>
        </form>
      </div>
    </section>
  );
}

type HostScreenProps = {
  copied: boolean;
  connectionState: ConnectionState;
  hostStatus: string;
  promptById: Map<string, { text: string }>;
  roomState: RoomState | null;
  onAdvance: () => void;
  onCopyLink: () => void;
  onGoHome: () => void;
  onOpenVoting: () => void;
  onReturnToLobby: () => void;
  onRevealResults: () => void;
  onStartGame: () => void;
};

function HostScreen({
  copied,
  connectionState,
  hostStatus,
  promptById,
  roomState,
  onAdvance,
  onCopyLink,
  onGoHome,
  onOpenVoting,
  onReturnToLobby,
  onRevealResults,
  onStartGame
}: HostScreenProps) {
  if (!roomState) {
    return (
      <section className="host-screen">
        <TopBar status={hostStatus} statusTone={connectionState} onGoHome={onGoHome} />
        <div className="marquee-board">
          <p className="board-label">Opening night</p>
          <h1>Making a room...</h1>
        </div>
      </section>
    );
  }

  const currentMatchup = getCurrentMatchup(roomState);
  const currentPrompt = currentMatchup ? promptById.get(currentMatchup.promptId)?.text : "";
  const connectedPlayers = roomState.players.filter((player) => player.connected);

  return (
    <section className="host-screen">
      <TopBar status={hostStatus} statusTone={connectionState} onGoHome={onGoHome} />

      <div className="room-marquee">
        <div>
          <p className="board-label">Room code</p>
          <h1>{roomState.roomCode}</h1>
        </div>
        <button className="button button-small" type="button" onClick={onCopyLink}>
          {copied ? "Copied" : "Copy Link"}
        </button>
      </div>

      {roomState.phase === "lobby" && (
        <LobbyHost players={roomState.players} onStartGame={onStartGame} />
      )}

      {roomState.phase === "answering" && (
        <AnsweringHost
          promptById={promptById}
          roomState={roomState}
          onOpenVoting={onOpenVoting}
        />
      )}

      {roomState.phase === "voting" && currentMatchup && (
        <VotingHost
          currentMatchup={currentMatchup}
          prompt={currentPrompt ?? ""}
          roomState={roomState}
          onRevealResults={onRevealResults}
        />
      )}

      {roomState.phase === "results" && currentMatchup && (
        <ResultsHost
          currentMatchup={currentMatchup}
          prompt={currentPrompt ?? ""}
          roomState={roomState}
          onAdvance={onAdvance}
        />
      )}

      {roomState.phase === "final" && (
        <FinalScoreboard
          players={connectedPlayers.length ? connectedPlayers : roomState.players}
          onReturnToLobby={onReturnToLobby}
        />
      )}
    </section>
  );
}

function TopBar({
  status,
  statusTone,
  onGoHome
}: {
  status: string;
  statusTone: ConnectionState;
  onGoHome: () => void;
}) {
  return (
    <header className="top-bar">
      <button className="brand-button" type="button" onClick={onGoHome}>
        Jazbox
      </button>
      <span className={`status-pill status-${statusTone}`}>{status}</span>
    </header>
  );
}

function LobbyHost({ players, onStartGame }: { players: RoomState["players"]; onStartGame: () => void }) {
  const connectedPlayers = players.filter((player) => player.connected);
  const canStart = connectedPlayers.length >= 2;

  return (
    <div className="phase-grid">
      <section className="show-panel wide-panel">
        <p className="panel-kicker">Lobby</p>
        <h2>{connectedPlayers.length} players in the cast</h2>
        <PlayerCloud players={players} />
      </section>
      <aside className="host-controls">
        <button className="button button-primary" disabled={!canStart} type="button" onClick={onStartGame}>
          Start Show
        </button>
        <p className="control-note">{canStart ? "Round one is ready." : "Need two players."}</p>
      </aside>
    </div>
  );
}

function AnsweringHost({
  promptById,
  roomState,
  onOpenVoting
}: {
  promptById: Map<string, { text: string }>;
  roomState: RoomState;
  onOpenVoting: () => void;
}) {
  const progress = getAnswerProgress(roomState);
  const complete = progress.required > 0 && progress.submitted >= progress.required;

  return (
    <div className="phase-grid">
      <section className="show-panel wide-panel">
        <p className="panel-kicker">Round {roomState.round}</p>
        <h2>Writing room</h2>
        <div className="progress-track">
          <span style={{ width: `${progress.required ? (progress.submitted / progress.required) * 100 : 0}%` }} />
        </div>
        <p className="big-count">
          {progress.submitted}/{progress.required}
        </p>
        <div className="match-list">
          {roomState.matchups.map((matchup) => (
            <div className="match-row" key={matchup.id}>
              <strong>{promptById.get(matchup.promptId)?.text}</strong>
              <span>{matchup.playerIds.map((playerId) => getPlayerName(roomState, playerId)).join(" vs ")}</span>
            </div>
          ))}
        </div>
      </section>
      <aside className="host-controls">
        <button className="button button-primary" disabled={!complete} type="button" onClick={onOpenVoting}>
          Open Voting
        </button>
        <p className="control-note">{complete ? "All answers are in." : "Phones are still typing."}</p>
      </aside>
    </div>
  );
}

function VotingHost({
  currentMatchup,
  prompt,
  roomState,
  onRevealResults
}: {
  currentMatchup: Matchup;
  prompt: string;
  roomState: RoomState;
  onRevealResults: () => void;
}) {
  const answers = getSubmittedAnswers(currentMatchup);
  const voteProgress = getVoteProgress(roomState, currentMatchup);
  const complete = voteProgress.submitted >= voteProgress.required;

  return (
    <div className="phase-stack">
      <PromptBoard eyebrow={`Match ${roomState.currentMatchIndex + 1}/${roomState.matchups.length}`} prompt={prompt} />
      <AnswerShowdown answers={answers} roomState={roomState} />
      <div className="host-ribbon">
        <span>
          Votes {voteProgress.submitted}/{voteProgress.required}
        </span>
        <button className="button button-primary" disabled={!complete} type="button" onClick={onRevealResults}>
          Reveal Results
        </button>
      </div>
    </div>
  );
}

function ResultsHost({
  currentMatchup,
  prompt,
  roomState,
  onAdvance
}: {
  currentMatchup: Matchup;
  prompt: string;
  roomState: RoomState;
  onAdvance: () => void;
}) {
  const answers = getSubmittedAnswers(currentMatchup);
  const voteTotals = getVoteTotals(currentMatchup);
  const lastMatch = roomState.currentMatchIndex >= roomState.matchups.length - 1;

  return (
    <div className="phase-stack">
      <PromptBoard eyebrow="Results" prompt={prompt} />
      <div className="answer-grid">
        {answers.map((answer) => (
          <article className="answer-card result-card" key={answer.playerId}>
            <p>{answer.answer}</p>
            <strong>{getPlayerName(roomState, answer.playerId)}</strong>
            <span>{voteTotals[answer.playerId] ?? 0} votes</span>
          </article>
        ))}
      </div>
      <div className="host-ribbon">
        <span>{lastMatch ? "Final scores are cued." : "Next bit is waiting."}</span>
        <button className="button button-primary" type="button" onClick={onAdvance}>
          {lastMatch ? "Finale" : "Next Match"}
        </button>
      </div>
    </div>
  );
}

function PlayerScreen({
  answerDrafts,
  connectionState,
  hostStatus,
  playerId,
  promptById,
  roomState,
  onAnswerDraftChange,
  onGoHome,
  onSend
}: {
  answerDrafts: Record<string, string>;
  connectionState: ConnectionState;
  hostStatus: string;
  playerId: string;
  promptById: Map<string, { text: string }>;
  roomState: RoomState | null;
  onAnswerDraftChange: (value: Record<string, string>) => void;
  onGoHome: () => void;
  onSend: (message: ClientToHostMessage) => void;
}) {
  if (!roomState || connectionState === "connecting") {
    return (
      <section className="phone-screen">
        <TopBar status={connectionState === "error" ? hostStatus : "Joining room"} statusTone={connectionState} onGoHome={onGoHome} />
        <div className="phone-panel">
          <p className="panel-kicker">Player phone</p>
          <h1>{connectionState === "error" ? "Can't join" : "Taking your seat..."}</h1>
          {connectionState === "error" && <button className="button button-secondary" onClick={onGoHome} type="button">Try Again</button>}
        </div>
      </section>
    );
  }

  if (connectionState === "closed") {
    return (
      <section className="phone-screen">
        <TopBar status="Host disconnected" statusTone="closed" onGoHome={onGoHome} />
        <div className="phone-panel">
          <p className="panel-kicker">Curtain down</p>
          <h1>Room closed</h1>
          <button className="button button-secondary" onClick={onGoHome} type="button">
            Home
          </button>
        </div>
      </section>
    );
  }

  const playerName = getPlayerName(roomState, playerId);

  return (
    <section className="phone-screen">
      <TopBar status={playerName} statusTone={connectionState} onGoHome={onGoHome} />
      <div className="phone-room-code">{roomState.roomCode}</div>

      {roomState.phase === "lobby" && (
        <div className="phone-panel">
          <p className="panel-kicker">Lobby</p>
          <h1>You're in.</h1>
          <PlayerCloud players={roomState.players} compact />
        </div>
      )}

      {roomState.phase === "answering" && (
        <AnswerPlayer
          answerDrafts={answerDrafts}
          playerId={playerId}
          promptById={promptById}
          roomState={roomState}
          onAnswerDraftChange={onAnswerDraftChange}
          onSend={onSend}
        />
      )}

      {roomState.phase === "voting" && (
        <VotePlayer playerId={playerId} promptById={promptById} roomState={roomState} onSend={onSend} />
      )}

      {roomState.phase === "results" && (
        <PlayerResults playerId={playerId} promptById={promptById} roomState={roomState} />
      )}

      {roomState.phase === "final" && <FinalScoreboard players={roomState.players} />}
    </section>
  );
}

function AnswerPlayer({
  answerDrafts,
  playerId,
  promptById,
  roomState,
  onAnswerDraftChange,
  onSend
}: {
  answerDrafts: Record<string, string>;
  playerId: string;
  promptById: Map<string, { text: string }>;
  roomState: RoomState;
  onAnswerDraftChange: (value: Record<string, string>) => void;
  onSend: (message: ClientToHostMessage) => void;
}) {
  const matchup = getPlayerMatchup(roomState, playerId);
  const alreadyAnswered = Boolean(matchup?.answers[playerId]);
  const draft = matchup ? answerDrafts[matchup.id] ?? "" : "";

  if (!matchup) {
    return (
      <div className="phone-panel">
        <p className="panel-kicker">Round {roomState.round}</p>
        <h1>You're watching this bit.</h1>
      </div>
    );
  }

  const prompt = promptById.get(matchup.promptId)?.text ?? "";

  return (
    <form
      className="phone-panel answer-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSend({ type: "submit_answer", matchId: matchup.id, answer: draft });
      }}
    >
      <p className="panel-kicker">Your prompt</p>
      <h1>{prompt}</h1>
      {alreadyAnswered ? (
        <div className="waiting-badge">Answer locked</div>
      ) : (
        <>
          <textarea
            autoFocus
            maxLength={90}
            onChange={(event) =>
              onAnswerDraftChange({ ...answerDrafts, [matchup.id]: event.target.value })
            }
            placeholder="Make the room laugh"
            value={draft}
          />
          <button className="button button-primary" disabled={!draft.trim()} type="submit">
            Send Answer
          </button>
        </>
      )}
    </form>
  );
}

function VotePlayer({
  playerId,
  promptById,
  roomState,
  onSend
}: {
  playerId: string;
  promptById: Map<string, { text: string }>;
  roomState: RoomState;
  onSend: (message: ClientToHostMessage) => void;
}) {
  const matchup = getCurrentMatchup(roomState);
  const prompt = matchup ? promptById.get(matchup.promptId)?.text ?? "" : "";
  const answers = getSubmittedAnswers(matchup);
  const votedFor = matchup?.votes[playerId];
  const eligible = matchup ? getEligibleVoterIds(roomState, matchup).includes(playerId) : false;

  return (
    <div className="phone-panel">
      <p className="panel-kicker">Vote</p>
      <h1>{prompt}</h1>
      {!eligible && <div className="waiting-badge">Watch this one</div>}
      {eligible && votedFor && <div className="waiting-badge">Vote locked</div>}
      {eligible && !votedFor && (
        <div className="choice-stack">
          {answers.map((answer) => {
            const ownAnswer = answer.playerId === playerId;

            return (
              <button
                className="answer-choice"
                disabled={ownAnswer}
                key={answer.playerId}
                onClick={() =>
                  onSend({
                    type: "submit_vote",
                    matchId: matchup?.id ?? "",
                    answerPlayerId: answer.playerId
                  })
                }
                type="button"
              >
                <span>{answer.answer}</span>
                {ownAnswer && <strong>Your answer</strong>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlayerResults({
  playerId,
  promptById,
  roomState
}: {
  playerId: string;
  promptById: Map<string, { text: string }>;
  roomState: RoomState;
}) {
  const matchup = getCurrentMatchup(roomState);
  const prompt = matchup ? promptById.get(matchup.promptId)?.text ?? "" : "";
  const answers = getSubmittedAnswers(matchup);
  const voteTotals = getVoteTotals(matchup);

  return (
    <div className="phone-panel">
      <p className="panel-kicker">Results</p>
      <h1>{prompt}</h1>
      <div className="choice-stack">
        {answers.map((answer) => (
          <div className={`answer-choice static-choice ${answer.playerId === playerId ? "own-choice" : ""}`} key={answer.playerId}>
            <span>{answer.answer}</span>
            <strong>
              {getPlayerName(roomState, answer.playerId)}: {voteTotals[answer.playerId] ?? 0}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptBoard({ eyebrow, prompt }: { eyebrow: string; prompt: string }) {
  return (
    <section className="prompt-board">
      <p className="board-label">{eyebrow}</p>
      <h1>{prompt}</h1>
    </section>
  );
}

function AnswerShowdown({
  answers,
  roomState
}: {
  answers: Array<{ playerId: string; answer: string }>;
  roomState: RoomState;
}) {
  return (
    <div className="answer-grid">
      {answers.map((answer, index) => (
        <article className={`answer-card answer-${index + 1}`} key={answer.playerId}>
          <p>{answer.answer}</p>
          <strong>{getPlayerName(roomState, answer.playerId)}</strong>
        </article>
      ))}
    </div>
  );
}

function FinalScoreboard({
  players,
  onReturnToLobby
}: {
  players: RoomState["players"];
  onReturnToLobby?: () => void;
}) {
  const rankedPlayers = [...players].sort((first, second) => second.score - first.score);

  return (
    <section className="show-panel scoreboard-panel">
      <p className="panel-kicker">Finale</p>
      <h2>Scoreboard</h2>
      <ol className="score-list">
        {rankedPlayers.map((player, index) => (
          <li key={player.id}>
            <span className="rank">{index + 1}</span>
            <span>{player.name}</span>
            <strong>{player.score}</strong>
          </li>
        ))}
      </ol>
      {onReturnToLobby && (
        <button className="button button-primary" type="button" onClick={onReturnToLobby}>
          New Show
        </button>
      )}
    </section>
  );
}

function PlayerCloud({ players, compact = false }: { players: RoomState["players"]; compact?: boolean }) {
  if (players.length === 0) {
    return <div className="empty-cast">Waiting for players</div>;
  }

  return (
    <div className={`player-cloud ${compact ? "compact" : ""}`}>
      {players.map((player) => (
        <span className={player.connected ? "" : "disconnected"} key={player.id}>
          {player.name}
        </span>
      ))}
    </div>
  );
}

export default App;
