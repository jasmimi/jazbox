import { useCallback, useMemo, useRef, useState } from "react";
import Peer, { DataConnection } from "peerjs";
import {
  MIN_PLAYERS,
  addPlayer,
  advanceFromReveal,
  createRoomState,
  getCurrentRound,
  getEligibleVoterIds,
  getPlayerName,
  getReadyProgress,
  getRoundOutcome,
  getVoteProgress,
  getVoteTotals,
  markPlayerDisconnected,
  openAccusation,
  openDiscussion,
  returnToLobby,
  revealResults,
  sanitizeName,
  startGame,
  submitReady,
  submitVote
} from "./game";
import { generateRoomCode, normalizeRoomCode, roomCodeToPeerId } from "./peer";
import { PROMPTS } from "./prompts";
import type { ActionPrompt, ClientToHostMessage, HostToClientMessage, RoomState, Round } from "./types";

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

      if (message.type === "submit_ready") {
        commitHostState(submitReady(currentState, connection.peer, message.roundId));
      }

      if (message.type === "submit_vote") {
        commitHostState(submitVote(currentState, connection.peer, message.roundId, message.suspectPlayerId));
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

  const hostOpenDiscussion = () => {
    if (roomRef.current) {
      commitHostState(openDiscussion(roomRef.current));
    }
  };

  const hostOpenAccusation = () => {
    if (roomRef.current) {
      commitHostState(openAccusation(roomRef.current));
    }
  };

  const hostRevealResults = () => {
    if (roomRef.current) {
      commitHostState(revealResults(roomRef.current));
    }
  };

  const hostAdvance = () => {
    if (roomRef.current) {
      commitHostState(advanceFromReveal(roomRef.current));
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
            onOpenAccusation={hostOpenAccusation}
            onOpenDiscussion={hostOpenDiscussion}
            onReturnToLobby={hostReturnToLobby}
            onRevealResults={hostRevealResults}
            onStartGame={hostStartGame}
          />
        )}

        {mode === "player" && (
          <PlayerScreen
            connectionState={connectionState}
            hostStatus={hostStatus}
            playerId={playerId}
            promptById={promptById}
            roomState={roomState}
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
            <h2>Find the faker</h2>
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
  promptById: Map<string, ActionPrompt>;
  roomState: RoomState | null;
  onAdvance: () => void;
  onCopyLink: () => void;
  onGoHome: () => void;
  onOpenAccusation: () => void;
  onOpenDiscussion: () => void;
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
  onOpenAccusation,
  onOpenDiscussion,
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

  const currentRound = getCurrentRound(roomState);
  const currentPrompt = currentRound ? promptById.get(currentRound.promptId) : undefined;
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

      {roomState.phase === "acting" && currentRound && (
        <ActingHost roomState={roomState} onOpenDiscussion={onOpenDiscussion} />
      )}

      {roomState.phase === "discussion" && currentRound && currentPrompt && (
        <DiscussionHost
          prompt={currentPrompt}
          roomState={roomState}
          onOpenAccusation={onOpenAccusation}
        />
      )}

      {roomState.phase === "accusing" && currentRound && currentPrompt && (
        <AccusingHost
          prompt={currentPrompt}
          roomState={roomState}
          round={currentRound}
          onRevealResults={onRevealResults}
        />
      )}

      {roomState.phase === "reveal" && currentRound && currentPrompt && (
        <RevealHost
          prompt={currentPrompt}
          roomState={roomState}
          round={currentRound}
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
  const canStart = connectedPlayers.length >= MIN_PLAYERS;

  return (
    <div className="phase-grid">
      <section className="show-panel wide-panel">
        <p className="panel-kicker">Lobby</p>
        <h2>{connectedPlayers.length} players in the room</h2>
        <PlayerCloud players={players} />
      </section>
      <aside className="host-controls">
        <button className="button button-primary" disabled={!canStart} type="button" onClick={onStartGame}>
          Start Show
        </button>
        <p className="control-note">{canStart ? "Round one is ready." : `Need ${MIN_PLAYERS} players.`}</p>
      </aside>
    </div>
  );
}

function ActingHost({
  roomState,
  onOpenDiscussion
}: {
  roomState: RoomState;
  onOpenDiscussion: () => void;
}) {
  const progress = getReadyProgress(roomState);
  const complete = progress.required > 0 && progress.submitted >= progress.required;

  return (
    <div className="phase-grid">
      <section className="show-panel wide-panel">
        <p className="panel-kicker">Round {roomState.round}/{roomState.maxRounds}</p>
        <h2>Phones have the prompt</h2>
        <div className="progress-track">
          <span style={{ width: `${progress.required ? (progress.submitted / progress.required) * 100 : 0}%` }} />
        </div>
        <p className="big-count">
          {progress.submitted}/{progress.required}
        </p>
        <div className="round-steps">
          <span>Act</span>
          <span>Discuss</span>
          <span>Accuse</span>
          <span>Reveal</span>
        </div>
      </section>
      <aside className="host-controls">
        <button className="button button-primary" disabled={!complete} type="button" onClick={onOpenDiscussion}>
          Open Discussion
        </button>
        <p className="control-note">{complete ? "Everyone is locked." : "Waiting on phones."}</p>
      </aside>
    </div>
  );
}

function DiscussionHost({
  prompt,
  roomState,
  onOpenAccusation
}: {
  prompt: ActionPrompt;
  roomState: RoomState;
  onOpenAccusation: () => void;
}) {
  return (
    <div className="phase-stack">
      <PromptBoard
        eyebrow={`Round ${roomState.round}/${roomState.maxRounds} - ${categoryLabel(prompt.category)}`}
        prompt={prompt.text}
      />
      <div className="host-ribbon">
        <span>Make the case.</span>
        <button className="button button-primary" type="button" onClick={onOpenAccusation}>
          Accuse
        </button>
      </div>
    </div>
  );
}

function AccusingHost({
  prompt,
  roomState,
  round,
  onRevealResults
}: {
  prompt: ActionPrompt;
  roomState: RoomState;
  round: Round;
  onRevealResults: () => void;
}) {
  const voteProgress = getVoteProgress(roomState, round);
  const complete = voteProgress.required > 0 && voteProgress.submitted >= voteProgress.required;

  return (
    <div className="phase-stack">
      <PromptBoard
        eyebrow={`Round ${roomState.round}/${roomState.maxRounds} - accusations`}
        prompt={prompt.text}
      />
      <section className="show-panel">
        <p className="panel-kicker">Votes</p>
        <h2>
          {voteProgress.submitted}/{voteProgress.required}
        </h2>
        <PlayerCloud players={roomState.players.filter((player) => round.playerIds.includes(player.id))} compact />
      </section>
      <div className="host-ribbon">
        <span>{complete ? "Votes are locked." : "Phones are choosing."}</span>
        <button className="button button-primary" disabled={!complete} type="button" onClick={onRevealResults}>
          Reveal Faker
        </button>
      </div>
    </div>
  );
}

function RevealHost({
  prompt,
  roomState,
  round,
  onAdvance
}: {
  prompt: ActionPrompt;
  roomState: RoomState;
  round: Round;
  onAdvance: () => void;
}) {
  const outcome = getRoundOutcome(round);
  const voteTotals = getVoteTotals(round);
  const lastRound = roomState.currentRoundIndex >= roomState.rounds.length - 1;

  return (
    <div className="phase-stack">
      <PromptBoard
        eyebrow={outcome.fakerCaught ? "Caught" : "Escaped"}
        prompt={`${getPlayerName(roomState, round.fakerId)} was the faker`}
      />
      <section className="show-panel reveal-panel">
        <p className="panel-kicker">{categoryLabel(prompt.category)}</p>
        <h2>{prompt.text}</h2>
        <div className="vote-grid">
          {round.playerIds.map((suspectId) => (
            <article className={`vote-card ${suspectId === round.fakerId ? "faker-card" : ""}`} key={suspectId}>
              <span>{getPlayerName(roomState, suspectId)}</span>
              <strong>{voteTotals[suspectId] ?? 0}</strong>
              {suspectId === round.fakerId && <em>Faker</em>}
            </article>
          ))}
        </div>
      </section>
      <div className="host-ribbon">
        <span>{outcome.splitVote && !outcome.fakerCaught ? "Split vote bonus." : "Scores updated."}</span>
        <button className="button button-primary" type="button" onClick={onAdvance}>
          {lastRound ? "Finale" : "Next Round"}
        </button>
      </div>
    </div>
  );
}

function PlayerScreen({
  connectionState,
  hostStatus,
  playerId,
  promptById,
  roomState,
  onGoHome,
  onSend
}: {
  connectionState: ConnectionState;
  hostStatus: string;
  playerId: string;
  promptById: Map<string, ActionPrompt>;
  roomState: RoomState | null;
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
  const currentRound = getCurrentRound(roomState);
  const currentPrompt = currentRound ? promptById.get(currentRound.promptId) : undefined;

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

      {roomState.phase === "acting" && currentRound && currentPrompt && (
        <ActionPlayer
          playerId={playerId}
          prompt={currentPrompt}
          roomState={roomState}
          round={currentRound}
          onSend={onSend}
        />
      )}

      {roomState.phase === "discussion" && currentRound && currentPrompt && (
        <DiscussionPlayer prompt={currentPrompt} roomState={roomState} />
      )}

      {roomState.phase === "accusing" && currentRound && (
        <AccusePlayer playerId={playerId} roomState={roomState} round={currentRound} onSend={onSend} />
      )}

      {roomState.phase === "reveal" && currentRound && currentPrompt && (
        <PlayerReveal playerId={playerId} prompt={currentPrompt} roomState={roomState} round={currentRound} />
      )}

      {roomState.phase === "final" && <FinalScoreboard players={roomState.players} />}
    </section>
  );
}

function ActionPlayer({
  playerId,
  prompt,
  roomState,
  round,
  onSend
}: {
  playerId: string;
  prompt: ActionPrompt;
  roomState: RoomState;
  round: Round;
  onSend: (message: ClientToHostMessage) => void;
}) {
  const isFaker = round.fakerId === playerId;
  const alreadyReady = round.readyPlayerIds.includes(playerId);

  return (
    <div className="phone-panel action-panel">
      <p className="panel-kicker">Round {roomState.round}/{roomState.maxRounds}</p>
      <span className={`role-badge ${isFaker ? "faker-role" : "real-role"}`}>
        {isFaker ? "Faker" : categoryLabel(prompt.category)}
      </span>
      <h1>{isFaker ? prompt.fakerHint : prompt.text}</h1>
      {alreadyReady ? (
        <div className="waiting-badge">Ready locked</div>
      ) : (
        <button
          className="button button-primary"
          type="button"
          onClick={() => onSend({ type: "submit_ready", roundId: round.id })}
        >
          Ready
        </button>
      )}
    </div>
  );
}

function DiscussionPlayer({ prompt, roomState }: { prompt: ActionPrompt; roomState: RoomState }) {
  return (
    <div className="phone-panel">
      <p className="panel-kicker">Round {roomState.round}/{roomState.maxRounds}</p>
      <span className="role-badge real-role">{categoryLabel(prompt.category)}</span>
      <h1>{prompt.text}</h1>
      <div className="waiting-badge">Discuss</div>
    </div>
  );
}

function AccusePlayer({
  playerId,
  roomState,
  round,
  onSend
}: {
  playerId: string;
  roomState: RoomState;
  round: Round;
  onSend: (message: ClientToHostMessage) => void;
}) {
  const votedFor = round.votes[playerId];
  const eligible = getEligibleVoterIds(roomState, round).includes(playerId);
  const suspects = roomState.players.filter((player) => round.playerIds.includes(player.id));

  return (
    <div className="phone-panel">
      <p className="panel-kicker">Accuse</p>
      <h1>Who was faking?</h1>
      {!eligible && <div className="waiting-badge">Watch this one</div>}
      {eligible && votedFor && <div className="waiting-badge">Vote locked: {getPlayerName(roomState, votedFor)}</div>}
      {eligible && !votedFor && (
        <div className="choice-stack">
          {suspects.map((suspect) => {
            const self = suspect.id === playerId;

            return (
              <button
                className="answer-choice suspect-choice"
                disabled={self}
                key={suspect.id}
                onClick={() =>
                  onSend({
                    type: "submit_vote",
                    roundId: round.id,
                    suspectPlayerId: suspect.id
                  })
                }
                type="button"
              >
                <span>{suspect.name}</span>
                {self && <strong>You</strong>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlayerReveal({
  playerId,
  prompt,
  roomState,
  round
}: {
  playerId: string;
  prompt: ActionPrompt;
  roomState: RoomState;
  round: Round;
}) {
  const outcome = getRoundOutcome(round);
  const voteTotals = getVoteTotals(round);
  const currentPlayer = roomState.players.find((player) => player.id === playerId);

  return (
    <div className="phone-panel">
      <p className="panel-kicker">{outcome.fakerCaught ? "Caught" : "Escaped"}</p>
      <h1>{round.fakerId === playerId ? "You were the faker" : `${getPlayerName(roomState, round.fakerId)} was the faker`}</h1>
      <span className="role-badge real-role">{categoryLabel(prompt.category)}</span>
      <div className="choice-stack">
        {round.playerIds.map((suspectId) => (
          <div className={`answer-choice static-choice ${suspectId === round.fakerId ? "own-choice" : ""}`} key={suspectId}>
            <span>{getPlayerName(roomState, suspectId)}</span>
            <strong>{voteTotals[suspectId] ?? 0} votes</strong>
          </div>
        ))}
      </div>
      <div className="waiting-badge">Score: {currentPlayer?.score ?? 0}</div>
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

function categoryLabel(category: ActionPrompt["category"]): string {
  const labels: Record<ActionPrompt["category"], string> = {
    pointing: "Pointing",
    numbers: "Numbers",
    hands: "Hands",
    choice: "Choice"
  };

  return labels[category];
}

export default App;
