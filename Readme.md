# Mini Discord

![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![status](https://img.shields.io/badge/status-personal%20project-lightgrey)

A self-hosted, Discord-style chat app: servers, channels, real-time messaging, and voice/video calls. The backend is Go on Fiber v2 with a single WebSocket hub and an embedded Pion SFU for calls (not a peer-to-peer mesh); the frontend is React 19 + TypeScript.

<!--
![Chat](docs/assets/chat.png)
Expected screenshots once captured: docs/assets/chat.png, docs/assets/voice.png, docs/assets/search.png
-->

## Features

**Auth** — Registration with email verification ([`docs/api.md`](docs/api.md)); JWT access + refresh tokens, `POST /tokens/renew`; avatar upload, profile updates, account deletion.

**Chat** — Servers/channels, membership, search & join; real-time messaging over one WS hub, edit/delete, replies ([`docs/architecture.md`](docs/architecture.md)); file/image/audio/video attachments via upload-then-send ([`docs/api.md`](docs/api.md#flows-that-dont-show-up-in-the-type-table)); @-mentions; ephemeral typing indicators; link previews with a three-tier cache and SSRF-hardened image proxy ([`docs/architecture.md`](docs/architecture.md#link-previews)); custom audio/video players with a lazy Web Audio equalizer/visualizer ([`docs/frontend.md`](docs/frontend.md#media-players)).

**Search & unread** — Full-text message search scoped to a channel or server; jump-to-message with a two-sided history window; per-channel unread tracking ([`docs/api.md`](docs/api.md)).

**Notifications** — In-app sound + browser notifications out of the box; per-server/per-channel overrides, mute, Do Not Disturb, hide-preview ([`docs/architecture.md`](docs/architecture.md#notifications-pipeline)); Web Push for closed-tab delivery, opt-in via VAPID keys ([`docs/deployment.md`](docs/deployment.md#web-push)).

**Voice/Video** — Server-side SFU (Pion), one `RTCPeerConnection` per client with four fixed publish slots; mic, camera, screen share, screen audio; reconnect grace period that keeps media flowing through brief WS drops; TURN/coturn with short-lived per-user credentials; live room/peer diagnostics and a headless SFU load-test client ([`docs/voice.md`](docs/voice.md)).

**Ops** — Per-action/user rate limiting (token bucket); graceful shutdown, structured JSON logging, request IDs ([`docs/architecture.md`](docs/architecture.md#cross-cutting)); two-path DB migrations kept in sync mechanically ([`docs/deployment.md`](docs/deployment.md#migrations--two-parallel-paths)).

## Architecture at a glance

```mermaid
flowchart LR
    Browser["Browser (React SPA)"]
    Browser -- "REST /api/v1" --> Fiber
    Browser -- "WebSocket /server/ws" --> Fiber
    Browser -. "WebRTC / DTLS-SRTP (direct UDP)" .-> SFU
    subgraph Fiber["Fiber app"]
        Handlers["user / notification / embed / webrtc handlers"]
        Hub["Hub (single goroutine)"]
    end
    subgraph SFU["SFU Router (same process)"]
    end
    Hub -. "Signaler / Authorizer interfaces" .-> SFU
    Handlers --> PG[(PostgreSQL)]
    Hub --> PG
    Handlers --> S3[(S3-compatible storage)]
    Handlers --> SMTP[(SMTP)]
    Hub --> Push[(Web Push)]
    style Hub fill:#4a5568,color:#fff
    style SFU fill:#2d3748,color:#fff
```

Three things worth internalizing before touching the backend: `Hub.Run` is a **single goroutine** — all chat/voice-membership state is mutated only there, never concurrently. The SFU lives in the same process but **does not import** `internal/service/server` — coupling goes only through the `Signaler`/`Authorizer` interfaces, and media itself flows directly over UDP, bypassing Fiber entirely. Nothing about an active call is persisted — voice/SFU state is in-memory only and disappears on restart.

See [`docs/architecture.md`](docs/architecture.md) for the rest.

## Tech stack

| Layer | Choice |
|---|---|
| Language | Go 1.25 |
| HTTP | Fiber v2 |
| WebSocket | `gofiber/contrib/websocket` |
| Voice/video | Pion WebRTC v4 (embedded SFU) |
| Database | PostgreSQL 18, `lib/pq` (raw SQL, no ORM) |
| Migrations | goose |
| Config | `cleanenv` (YAML + env overlay) |
| Auth | `golang-jwt` v5, bcrypt |
| Object storage | AWS SDK v2 against Yandex Object Storage (S3-compatible) |
| Web Push | `webpush-go` |
| Frontend | React 19 + Vite + TypeScript |

## Project structure

```
cmd/                    # Entrypoints: discord_go (server), genvapid, sfuload (load test)
config/                 # Gitignored YAML config (see Quick start)
docs/                   # Topic docs — see "Documentation" below
frontend/               # React 19 + Vite + TypeScript SPA
internal/
├── config/              # YAML+env config loading (cleanenv, singleton)
├── lib/                 # Composition root (api/), graceful shutdown (closer/), logging (logger/)
├── middleware/           # JWT auth, rate limiting, request ID, recovery, logger
├── service/
│   ├── auth/             # JWT issuance, password hashing
│   ├── embed/            # Link-preview fetch/cache pipeline
│   ├── mailer/           # SMTP verification emails
│   ├── notification/     # Notification-settings + push REST handlers
│   ├── push/             # Web Push worker pool + aggregation
│   ├── server/           # The hub: WS connections, chat/voice state
│   ├── sfu/              # Pion-based SFU: rooms, peers, simulcast
│   ├── user/              # Auth/profile/avatar/upload REST handlers
│   └── webrtc/            # TURN credential minting
└── storage/
    ├── cache/              # Generic TTL map
    ├── objectStorage/      # S3-compatible client
    ├── postgresql/         # Storage interface implementation, raw SQL
    └── single_flight/       # Concurrent-call deduplication
sql/
├── schema/               # goose migrations (make up/down)
└── init/                 # Idempotent mirror for docker-compose's migrate service
types/                  # Shared types + storage interfaces + the WS wire contract
utils/                  # JSON/validation/URL helpers
```

Authoritative: the tree itself — regenerate with `find . -type d`.

## Quick start

**Requirements:** Go 1.25+, PostgreSQL 18, [goose](https://github.com/pressly/goose), Node 20+ (frontend only), Docker (optional, for the all-in-one path).

1. Clone and create `local.env` in the repo root (gitignored):

   ```env
   CONFIG_PATH=./config/local.yaml
   DB_URL=postgres://user:pass@localhost:5432/postgres?sslmode=disable
   ```

2. Create `config/local.yaml` (the whole `config/` directory is gitignored) — minimal working template, only the `env-required` fields plus a couple of obvious ones:

   ```yaml
   env: "local"
   storage_path: "postgres://user:pass@localhost:5432/postgres?sslmode=disable"
   http_server:
     host: "localhost:8080"
     user: "myuser"
     password: "mypass"
   jwt_secret: "your-secret-key"
   s3:
     bucket: "your-bucket"
     access_key_id: "your-key-id"
     secret_access_key: "your-secret-key"
   ```

   The `s3.*` fields are `env-required` — without them `config.MustLoad()` calls `log.Fatal` and the process exits at startup. Full schema (mail, push, link previews, TURN/SFU, etc.): [`docs/deployment.md`](docs/deployment.md#config-reference) and `internal/config/config.go`.

3. Apply migrations and run:

   ```bash
   make up
   make run
   ```

4. Frontend, in a separate shell:

   ```bash
   cd frontend
   npm install
   npm run dev   # http://localhost:5174 (strictPort)
   ```

**All-in-one alternative:**

```bash
docker compose up -d --build
```

This brings up `db` → `migrate` → `backend` → `frontend` in dependency order — see [`docs/deployment.md`](docs/deployment.md) for what each service does and the full migration story.

## Make targets

| Target | Does |
|---|---|
| `make build` | Build the binary to `bin/discord_go.exe` |
| `make run` | Build, then run |
| `make up` | Apply DB migrations (goose, `sql/schema`) |
| `make down` | Roll back DB migrations |
| `make genvapid` | Generate a VAPID key pair for Web Push |
| `make doc-check` | Fail if any exported Go symbol is missing a godoc comment |
| `make docs-check` | Fail if code and `docs/`/`Readme.md` have drifted (WS actions/events, REST routes, migrations, make targets) — see below |
| `make deploy` | Deploy to a server over SSH via `scripts/deploy.sh` |

## Environments

| `env` | Log level |
|---|---|
| `local` | Debug (JSON) |
| `dev` | Debug (JSON) |
| `prod` | Info (JSON) |

## Tests

Backend tests currently live only in `internal/service/sfu/` (simulcast layer selection, RTP sequence rewriting, active-speaker detection, publish-state semantics, plus `smoke_test.go` which actually binds the UDP mux) and `cmd/sfuload`, a headless load-test client. There is **no frontend test runner** — UI changes are verified manually. See [`docs/voice.md`](docs/voice.md#tests) for the test file breakdown.

```bash
go test ./...
go test ./internal/service/sfu -run TestForwardToSubscribersSwitchesOnlyOnKeyframe -v   # single test
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the hub, storage layer, link previews, notifications, boundaries to preserve
- [`docs/api.md`](docs/api.md) — REST routes and the full WS action/event contract
- [`docs/voice.md`](docs/voice.md) — the SFU, signaling, TURN/coturn, diagnostics
- [`docs/deployment.md`](docs/deployment.md) — docker compose, migrations, config reference, S3/push/nginx
- [`docs/frontend.md`](docs/frontend.md) — hooks/services layout, media players, CORS pitfalls

Field lists and directory trees in `docs/` link back to the code rather than duplicating it — the one exception is the minimal config template in "Quick start" above, kept here because it's the first thing a new clone needs.

`make docs-check` (`scripts/docscheck.go`) mechanically checks that every `WsAction*`/`WsEvent*` value, every REST route, every `sql/init/` migration file, and every Make target is *mentioned* somewhere in the docs above — it catches "forgot to document," not "documented incorrectly."

## License

MIT
