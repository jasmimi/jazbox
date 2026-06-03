# Jazbox

A static, Jackbox-style party game app. The first game is a Quiplash-like round where a host creates a room, players join with a room code, answer prompts, vote, and see a final scoreboard.

## Local Development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Checks

```bash
npm test
npm run build
npm audit
```

## GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/deploy.yml`. Push `init` or `main`, then enable GitHub Pages with **GitHub Actions** as the source in the repository settings.

The Vite production base path is `/jazbox/`, which matches a project page hosted from a repo named `jazbox`.

## Realtime Rooms

Rooms use PeerJS Cloud for WebRTC signaling. The host browser owns the room state; if the host closes or refreshes, that room ends.
