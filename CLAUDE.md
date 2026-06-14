# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Mini Discord clone: Go backend (Fiber REST API + WebSocket hub) and a Vite/React 19/TypeScript frontend. Features: JWT auth, servers, channels (text + voice), real-time chat, WebRTC voice/video signaling, and S3 file/avatar uploads.

> **README/code drift:** `Readme.md` claims Chi router and a JWT-only auth scope, but the code uses **Fiber v2** and includes the full server/channel/WebRTC stack. **Trust the code + `go.mod`, not the README.** `AGENTS.md` is more accurate than `Readme.md`.

## Commands

```bash
# Backend (from repo root)
make build          # go build -o bin/discord_go cmd/discord_go/main.go
make run            # build + run (requires local.env + config/local.yaml)
make up             # goose migrate up   (uses DB_URL from local.env, dir sql/schema)
make down           # goose migrate down

# Frontend (from frontend/)
npm run dev         # vite dev server on :5173
npm run build       # tsc -b && vite build
npm run lint        # eslint

# Production stack (docker compose: db + migrate + api + frontend + coturn)
docker compose up -d --build
```

There are **no Go test/lint targets** and no `*_test.go` files, despite `testify` and `go-sqlmock` being in `go.mod`. Use `go vet ./...` / `go build ./...` to sanity-check Go changes.

## Required setup before running

Both files are **gitignored** and must be created manually after clone:
1. `local.env` — at minimum `CONFIG_PATH=./config/local.yaml` and `DB_URL=postgres://...`. The Makefile does `include local.env` + `export`, so its vars become process env vars.
2. `config/local.yaml` — see template in `Readme.md`. `config/` is gitignored except checked-in examples.
3. PostgreSQL running before `make up` / `make run`.

Config is YAML loaded via `CONFIG_PATH`, then env vars overlay any field with an `env:` tag (e.g. `JWT_SECRET`, `S3_BUCKET`, `TURN_*`). See `internal/config/config.go` for the full schema and which fields are `env-required`.

## Architecture

**Startup chain:** `cmd/discord_go/main.go` → `config.MustLoad()` (singleton via `sync.Once`) → `postgresql.New()` → `api.NewAPIServer(...).Run()`.

**`internal/lib/api/api.go`** builds the Fiber app, applies middleware (Recovery → RequestID → Logger → CORS), mounts everything under `/api/v1`, and wires two feature areas:
- `user.Handler` (`internal/service/user/`) — REST: register, login, token renew, update/delete user, avatar get/set, file upload. JWT-protected routes use `middleware.WithJWTAuth`.
- `server.Hub` + `server.Handler` (`internal/service/server/`) — single WebSocket endpoint `/api/v1/server/ws` for **all** real-time features.

It also handles graceful shutdown: SIGINT/SIGTERM → `app.ShutdownWithContext` → `closer.CloseAll` (resources register themselves with `internal/lib/closer`).

### WebSocket hub (the core of real-time features)

`internal/service/server/hub.go` is the single goroutine event loop (`Hub.Run`) driven by `Register`, `Unregister`, and `Commands` channels — this serializes all state mutation, so most hub maps are guarded by `h.mu` only for concurrent reads from handler code.

- One `Client` per connected user (`clientsByUser map[int]*Client`); a new connection for the same user evicts the old one. Each client has an `Outbound` channel drained by a per-client writer goroutine (`client.go`).
- Commands arrive as `types.WsCommand{Action, Payload}`; `handleCommand` switches on the action and unmarshals the action-specific payload struct from `types/websocket.go`.
- Actions cover chat (create/delete server, channel, message; get messages with cursor pagination), presence (`get_users_online`), and voice (`join/leave_voice_channel`, `change_voice_status`, `rtc_signal`).
- **WebRTC is signaling-only:** the hub relays SDP `offer`/`answer`/`candidate` between peers (`relayRTCSignal`); media is peer-to-peer/TURN-relayed, never through the backend. Voice membership lives in in-memory maps (`voiceParticipants`, `userVoiceChannel`, `voiceStatusByUser`) — not persisted.
- **Attachments flow:** files are uploaded via REST first → stored as a `PendingAttachment` in the hub (in-memory, ID-keyed) → referenced by `attachment_ids` in a `send_message` command, which atomically persists message + attachments.
- Rate limiting uses `middleware.TokenBucket` instances per action (create server/channel, send message), keyed by user ID.

### Storage layer

- `internal/storage/postgresql/` — `Storage` implements the DB interfaces (`user.go`, `websocket.go`). Driver is `lib/pq`.
- `internal/storage/objectStorage/s3Client.go` — S3 (AWS SDK v2, pointed at Yandex Cloud). Avatar/attachment URLs are built from stored keys via `utils.AvatarURLFromKey(key, s3Host)`.
- `internal/storage/cache/` (TTL in-memory cache) and `internal/storage/single_flight/` (dedupe concurrent identical loads) are general-purpose helpers.
- **Interfaces live in `types/`** (`UserStorage`, `ServerStorage`, `S3ClientStorage`, `PendingAttachmentStore`, etc.), not in the storage package — handlers depend on these interfaces, concrete `*postgresql.Storage` satisfies them.

### Types

`types/` holds all shared structs **and** the storage interfaces. `types/websocket.go` is the contract between frontend and backend for every WS action/event — keep it in sync with `frontend/src/services/chatSocket.ts` and `frontend/src/types/chat.ts`.

### Middleware

`internal/middleware/`: `auth.go` (`WithJWTAuth`), `logger.go`, `recovery.go`, `request_id.go`, `token_bucket.go`. The token bucket exposes both a Fiber middleware (`FiberRateLimitMiddleware`) for REST and a plain `Allow(key)` used inside the hub.

## Database migrations — two parallel paths (keep in sync)

- **`sql/schema/`** — Goose numbered migrations, run by `make up`/`make down`. **Add new schema changes here.**
- **`sql/init/`** — plain SQL for the docker-compose `migrate` service / Postgres `docker-entrypoint-initdb.d`. Exists because an existing Postgres volume skips the standard init dir. These can drift from `sql/schema/` — update both when changing schema.

## Frontend

`frontend/src/`: `pages/` (Login, Register, ChatPage), `components/` (channel/message/video UI), and `services/` which is where the backend contract lives — `chatSocket.ts` (WS client), `chatApi.ts`/`avatarApi.ts`/`turnApi.ts` (REST), `callClient.ts` (WebRTC peer connections), `authToken.ts`. WebRTC config (STUN/TURN) comes from `VITE_*` env vars (see `frontend/.env.production.example`).

## Conventions & gotchas

- The Go module path is `github.com/wlqoh/mini_discord.git` (note the literal `.git` suffix) — match it exactly in imports.
- **CORS and WebSocket origins are validated separately:** `http_server.cors_allowed_origins` vs `http_server.ws_allowed_origins`.
- Logging is `slog` JSON everywhere; level depends on `env` (`local`/`dev` = Debug, `prod` = Info).
- In production the frontend container binds `127.0.0.1:8081:80`; public traffic goes through host Nginx, and `/api/v1/auth/*` is rewritten to `/api/v1/*` in `frontend/nginx.conf`.
- TURN (coturn) is required for reliable cross-NAT calls; see `Readme.md` "Required TURN setup" for ports, certs (`deploy/coturn/certs/`), and `TURN_*` env vars.
