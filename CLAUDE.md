# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Go backend (Fiber v2) + React/TypeScript frontend for a mini-Discord clone: REST auth/user endpoints plus a single-goroutine WebSocket hub for real-time chat and WebRTC voice/video.

## Conventions & gotchas that bite

- **Module path is `github.com/wlqoh/mini_discord.git`** — the `.git` suffix is intentional. Keep it in every import.
- **Trust the code over `Readme.md`.** The README (in Russian) claims Chi + a tiny route set; the actual framework is **Fiber v2** and the real routes are in `internal/service/user/routes.go`. The README also documents a `docker-compose.yml` that is not present in the repo.
- **No Go test files exist yet** despite `testify` and `go-sqlmock` being in `go.mod`. Run a single test with `go test ./internal/... -run TestName`.
- **`local.env` must exist before any `make` target** — the Makefile opens with `include local.env` + `export`. `local.env` and `config/` are gitignored (the latter holds real S3/JWT secrets). See `Readme.md` for the expected `local.env` / `config/local.yaml` shape.
- Config is a `cleanenv` singleton loaded from `CONFIG_PATH` (a YAML file). `config.MustLoad()` uses `sync.Once`, so repeat calls are safe. Most fields also accept env-var overrides (e.g. `JWT_SECRET`, `S3_BUCKET`, `TURN_URLS`).
- **Database schema changes need TWO files:** a Goose migration in `sql/schema/` (e.g. `015_*.sql`) **and** a matching idempotent init script in `sql/init/` (consumed by the `migrate` service in Docker deployments, since Postgres skips `/docker-entrypoint-initdb.d` on existing volumes).

## Commands

```bash
make build   # go build -> bin/discord_go
make run     # build + run (needs local.env)
make up      # goose migrate up   (needs DB_URL from local.env)
make down    # goose migrate down
```

Goose directly: `goose -dir ./sql/schema postgres "$DB_URL" up`

Frontend (from `frontend/`): `npm run dev` (Vite), `npm run build` (`tsc -b && vite build`), `npm run lint` (eslint).

## Architecture

Request flow starts at `cmd/discord_go/main.go` → `internal/lib/api/api.go` (`APIServer.Run`), which wires the Fiber app, global middleware, the user REST handler, and the WebSocket hub under the `/api/v1` group.

- **Two surfaces, one process:**
  - **REST** (`internal/service/user/`) — register/login, token renewal, avatar + generic file upload, user update/delete. JWT via `Authorization: Bearer`.
  - **WebSocket hub** (`internal/service/server/`) — `hub.go` (state + command dispatch), `handler.go` (upgrade + auth + origin check), `client.go` (per-conn read/write pumps). Endpoint: `GET /api/v1/server/ws`. WS auth uses the `jwt` cookie or `?token=` query param.
- **The Hub is a single goroutine.** `Hub.Run()` selects over `Register`/`Unregister`/`Commands` channels; all mutations of hub maps happen there or under `h.mu`. Each client has a buffered `Outbound` channel — events are dropped (not blocked) when it's full (`enqueueEvent`), except `rtc_signal` which gets a 300ms timeout.
- **Adding a WS action** is a three-step change: add the `WsAction*` constant in `types/websocket.go`, add a `case` to the `switch` in `Hub.handleCommand()` (`hub.go`), and implement the handler method. Inbound = `types.WsCommand{Action, Payload}`; outbound = `types.WsEvent{Event, Data, Error}`.
- **Storage layer** (`internal/storage/postgresql/`) — the `Storage` struct must satisfy both `types.UserStorage` and `types.ServerStorage`. It wraps the `*sql.DB` with an in-memory **cache** (`internal/storage/cache/`, TTL 5min/cleanup 10min) and a **single-flight** layer (`internal/storage/single_flight/`) to collapse duplicate concurrent reads. Cache keys are the `*Key` consts at the top of `postgresql.go` — **invalidate them on writes.**
- **Object storage** (`internal/storage/objectStorage/s3Client.go`) — AWS SDK v2 against an S3-compatible endpoint (Yandex by default) for avatars and chat attachments.
- **Graceful shutdown** — `api.go` listens for SIGINT/SIGTERM, calls `app.ShutdownWithContext`, then `closer.CloseAll` (`internal/lib/closer/`). Register cleanup with `closer.Add(...)` (the DB does this in `postgresql.New`).

## Cross-cutting behavior

- **Rate limiting is token-bucket, keyed per user-id** (not per-IP) — `internal/middleware/token_bucket.go`. Used both as Fiber middleware on REST routes (`FiberRateLimitMiddleware`) and directly inside hub handlers (`createServer`/`createChannel`/`sendMessage` call `.Allow(userID)`).
- **Attachments use a two-step flow:** client `POST /api/v1/upload` → file goes to S3, a `PendingAttachment` is held **in-memory in the Hub** (`StorePendingAttachment`, keyed by an atomic counter) and an `attachment_id` is returned → client sends WS `send_message` with `attachment_ids` → `TakePendingAttachment` (ownership-checked) moves them onto the saved message. Pending attachments do not survive a restart.
- **WebRTC** signaling rides the same WS connection: `join_voice_channel` / `leave_voice_channel` / `rtc_signal` (offer/answer/candidate), relayed peer-to-peer by the hub. Channels are typed `text` or `voice` (`types.ChannelType*`). Voice participant state (mic/deafen, who's in which channel) lives only in hub memory. TURN/coturn setup for production is documented in `Readme.md`.
- **Origin allow-lists:** `http_server.cors_allowed_origins` (REST CORS) and `http_server.ws_allowed_origins` (WS upgrade) in config.
- Global middleware chain (`api.go`): `Recovery` → `RequestID` → `Logger` → CORS. Logging is `slog` JSON; level is Debug for `local`/`dev`, Info for `prod` (`setupLogger` in `main.go`).
