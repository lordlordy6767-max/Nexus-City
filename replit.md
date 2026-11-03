# NEXUS CITY ONLINE

A low-poly multiplayer city sandbox where players explore, drive, chat, and compete in a shared 400 × 400 city.

## Run & Operate

- `npm run dev --workspace=@workspace/api-server` — run the API server (port 8080 in the managed workflow)
- `npm run dev --workspace=@workspace/3d-game` — run the game client
- `npm run typecheck` — full typecheck across all packages
- `npm run build` — typecheck + build all packages
- `npm run codegen --workspace=@workspace/api-spec` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `npm run push --workspace=@workspace/db` — push DB schema changes (dev only)

## Stack

- npm workspaces, Node.js 24, TypeScript 5.9
- API and multiplayer: Express 5 + Socket.IO
- Game client: React + Vite + Three.js r160
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/3d-game/src/Game.tsx` — city rendering, controls, multiplayer client, and HUD
- `artifacts/3d-game/src/index.css` — game visual theme and responsive layout
- `artifacts/api-server/src/lib/realtime-game.ts` — in-memory world state and Socket.IO gameplay
- `artifacts/api-server/src/routes/game.ts` — multiplayer server status endpoint
- `lib/api-spec/openapi.yaml` — HTTP API contract source of truth

## Architecture decisions

- Keep the game UI in a web artifact and attach realtime play to the shared API server.
- Use server-owned movement, car locks, hit resolution, and wanted state; clients render interpolated snapshots.
- Keep this first version session-based and in memory; player stats reset when the API process restarts.
- Send full world snapshots at 20 Hz so reconnecting clients can resynchronize without replaying missed events.

## Product

- Players join as randomly colored characters, explore the city, claim one of five shared cars, chat, and shoot.
- Players can see live health, cash, kills, wanted level, online count, police pursuit, and a minimap.
- The 3D scene uses WebGL when available and falls back to a lightweight canvas scene when WebGL cannot start.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Keep `/api/socket.io` listed in the API artifact's routed paths; the proxy needs it for realtime connections.
- The preview capture browser cannot create WebGL contexts. Its fallback scene is useful for previewing the HUD and multiplayer state but is not the full 3D renderer.
- In-memory player and vehicle state is shared only while this API server process is running.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
