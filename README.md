# Jazbox

A static, Jackbox-style party game app. The current game is a Fakin' It-inspired hidden-faker round where a host creates a room, players join with phones, perform physical prompts, accuse the faker, and see a final scoreboard.

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

Devices do not need to be on the same local network. They do need internet access, and restrictive firewalls or public networks may block WebRTC connections.
