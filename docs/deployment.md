# Deployment

> Authoritative: `internal/config/config.go`, `docker-compose.yml`, `sql/`

## docker compose

`docker compose up -d --build` brings up four services, in dependency order:

```
db  →  migrate  →  backend  →  frontend
```

- `db` — Postgres (`postgres:17-alpine` in the current compose file),
  healthchecked with `pg_isready`; `migrate` and `backend` both wait on
  `service_healthy` before starting.
- `migrate` — a throwaway `psql` container that applies every file in
  `sql/init/` in an explicit order (see "Migrations" below), then exits;
  `backend` waits on `service_completed_successfully`.
- `backend` — the Go binary. Needs `TURN_STATIC_AUTH_SECRET` (must match
  coturn's `static-auth-secret`, `use-auth-secret` enabled — otherwise TURN
  credential minting 404s and the frontend silently falls back to STUN-only,
  which fails for anyone behind a symmetric NAT/CGNAT) and the SFU env vars.
  `${SFU_UDP_PORT:-7881}/udp` is published on the host — **this must match
  `SFU_UDP_PORT` in the backend's own environment**, or Pion binds a port the
  compose file never actually exposes.
- `frontend` — built with the `VITE_*` build args baked in at image-build
  time (Vite inlines env vars into the bundle, so these can't be changed at
  container-start time the way backend env vars can).

## Migrations — two parallel paths

Schema changes are tracked in **two** places that must be kept in sync by
hand:

- `sql/schema/NNN_*.sql` — goose migrations with `-- +goose Up/Down` markers,
  applied by `make up` / `make down` against a real database using
  `goose -dir ./sql/schema`.
- `sql/init/NN_*.sql` — the same DDL, **without** goose markers, written
  idempotently (`IF NOT EXISTS` throughout), applied by the `migrate`
  compose service, which runs each file through `psql` **by an explicit list
  of filenames** in its `command`.

The numbering between the two directories is **offset by one** and doesn't
otherwise line up — match files by content, not by number:

| `sql/schema/` | `sql/init/` | Adds |
|---|---|---|
| `001_users.sql` | `01_users.sql` | users table |
| `002_servers.sql` + `003_server_members.sql` + `004_channels.sql` + `005_messages.sql` + `006_servers_name_idx.sql` | `02_chat_schema.sql` | servers/channels/members/messages |
| `007_users_avatar_key.sql` | `03_users_avatar_key.sql` | avatar key column |
| `008_message_attachments.sql` | `04_message_attachments.sql` | attachments table |
| `009_users_attachment_folder_key.sql` | `05_users_attachment_folder_key.sql` | per-user upload folder key |
| `010_users_nicknames.sql` | `06_users_nickname.sql` | nickname column |
| `012_drop_message_attachments_file_name.sql` + `013_drop_message_attachments_content_type.sql` + `014_add_message_attachments_content_type_and_file_name.sql` | *(collapsed into)* `04_message_attachments.sql`'s idempotent form | attachment column churn |
| `015_messages_reply_to.sql` | `07_messages_reply_to.sql` | reply-to column |
| `016_users_soft_delete.sql` | `08_users_soft_delete.sql` | soft delete |
| `017_users_email_verification.sql` | `09_users_email_verification.sql` | email verification |
| `018_channel_reads.sql` | `10_channel_reads.sql` | unread tracking |
| `019_message_mentions.sql` | `11_message_mentions.sql` | mentions |
| `020_notification_settings.sql` | `12_notification_settings.sql` | notification settings |
| `021_push_subscriptions.sql` | `13_push_subscriptions.sql` | push subscriptions |
| `022_link_previews.sql` | `14_link_previews.sql` | link previews / embeds |
| `023_messages_search.sql` | `15_messages_search.sql` | full-text search |

Note `sql/schema/` has no `011` — the number was apparently used by a
migration that was later removed; goose doesn't expect an `011` to exist on
any real database and this is harmless, but it's a gap worth knowing about
if you're ever debugging migration state.

**Checklist for any schema change:**

1. Add the new goose migration to `sql/schema/`.
2. Add its idempotent mirror to `sql/init/`.
3. Add a new line to the `migrate` service's `command` in
   `docker-compose.yml` (it is *not* auto-discovered — a file you forget to
   list here simply never runs in a compose deployment).
4. Run `make docs-check` — it fails if the sets of filenames in `sql/init/`
   and the `migrate` command's `-f` list don't match exactly.

## Config reference

> Authoritative: `internal/config/config.go`

Config is loaded once (`config.MustLoad`, `sync.Once`) from the YAML file at
`CONFIG_PATH`, an env var, not a config field. Any field tagged `env:"..."`
is then overlaid from its own environment variable if set — env always wins
over YAML for those fields. A field tagged `env-required:"true"` must
resolve to a non-empty value from *either* source, or `MustLoad` calls
`log.Fatal` and the process exits.

| YAML path | env var | default | required |
|---|---|---|---|
| `env` | — | `local` | |
| `storage_path` | — | | ✅ |
| `S3_HOST` | — | `https://storage.yandexcloud.net/` | |
| `s3.endpoint` | `S3_ENDPOINT` | `https://storage.yandexcloud.net` | |
| `s3.region` | `S3_REGION` | `ru-central1` | |
| `s3.bucket` | `S3_BUCKET` | | ✅ |
| `s3.access_key_id` | `S3_ACCESS_KEY_ID` | | ✅ |
| `s3.secret_access_key` | `S3_SECRET_ACCESS_KEY` | | ✅ |
| `http_server.host` | — | `localhost:8080` | |
| `http_server.timeout` | — | `4s` | |
| `http_server.idle_timeout` | — | `60s` | |
| `http_server.user` | — | | ✅ |
| `http_server.password` | `HTTP_SERVER_PASSWORD` | | ✅ |
| `http_server.cors_allowed_origins` | — | `*` | |
| `http_server.ws_allowed_origins` | — | (empty = check disabled) | |
| `jwt_secret` | `JWT_SECRET` | | ✅ |
| `jwt_access_expiration_in_minutes` | — | `10080` (1 week) | |
| `jwt_refresh_expiration_in_minutes` | — | `43200` (1 month) | |
| `frontend_base_url` | `FRONTEND_BASE_URL` | `http://localhost:5173` | |
| `mail.smtp_host` | `SMTP_HOST` | | |
| `mail.smtp_port` | `SMTP_PORT` | `587` | |
| `mail.smtp_username` | `SMTP_USERNAME` | | |
| `mail.smtp_password` | `SMTP_PASSWORD` | | |
| `mail.from_address` | `MAIL_FROM_ADDRESS` | | |
| `mail.from_name` | `MAIL_FROM_NAME` | `Mini Discord` | |
| `push.enabled` | `PUSH_ENABLED` | `false` | |
| `push.vapid_public_key` | `VAPID_PUBLIC_KEY` | | |
| `push.vapid_private_key` | `VAPID_PRIVATE_KEY` | | |
| `push.vapid_subject` | `VAPID_SUBJECT` | `mailto:admin@example.com` | |
| `push.ttl_seconds` | `PUSH_TTL_SECONDS` | `43200` | |
| `link_preview.enabled` | `LINK_PREVIEW_ENABLED` | `true` | |
| `link_preview.timeout` | `LINK_PREVIEW_TIMEOUT` | `5s` | |
| `link_preview.max_body_bytes` | `LINK_PREVIEW_MAX_BODY_BYTES` | `524288` | |
| `link_preview.max_image_bytes` | `LINK_PREVIEW_MAX_IMAGE_BYTES` | `2097152` | |
| `link_preview.max_redirects` | `LINK_PREVIEW_MAX_REDIRECTS` | `3` | |
| `link_preview.cache_ttl` | `LINK_PREVIEW_CACHE_TTL` | `168h` | |
| `link_preview.negative_cache_ttl` | `LINK_PREVIEW_NEGATIVE_TTL` | `6h` | |
| `link_preview.workers` | `LINK_PREVIEW_WORKERS` | `4` | |
| `link_preview.user_agent` | `LINK_PREVIEW_USER_AGENT` | `MiniDiscordBot/1.0 (+link preview)` | |
| `webrtc.turn_urls` | `TURN_URLS` (comma-separated) | | |
| `webrtc.turn_static_auth_secret` | `TURN_STATIC_AUTH_SECRET` | | |
| `webrtc.turn_credentials_ttl_seconds` | `TURN_CREDENTIALS_TTL_SECONDS` | `600` | |
| `webrtc.sfu.enabled` | `SFU_ENABLED` | `false` | |
| `webrtc.sfu.public_ip` | `SFU_PUBLIC_IP` | | required *if* SFU enabled (see [`voice.md`](voice.md)) |
| `webrtc.sfu.udp_port` | `SFU_UDP_PORT` | `7881` | |
| `webrtc.sfu.stun_urls` | `SFU_STUN_URLS` (comma-separated) | | |
| `webrtc.sfu.max_room_participants` | `SFU_MAX_ROOM_PARTICIPANTS` | `20` | |
| `webrtc.sfu.session_grace_period` | `SFU_SESSION_GRACE_PERIOD` | `30s` | |
| `webrtc.sfu.reconcile_interval` | `SFU_RECONCILE_INTERVAL` | `15s` | `0` disables the ghost-session sweep (see [`voice.md`](voice.md)) |

`env-required` fields (✅ above) are the ones that make `MustLoad` fatal if
missing: `storage_path`, `jwt_secret`, `http_server.user`,
`http_server.password`, `s3.bucket`, `s3.access_key_id`,
`s3.secret_access_key`. Note `webrtc.sfu.public_ip` is *not*
`env-required` at the type level — it's a soft requirement enforced by
behavior (ICE breaks silently) rather than by `MustLoad` refusing to start.

## S3 / Yandex Object Storage

`internal/storage/objectStorage/s3Client.go` targets a Yandex Object Storage
bucket through the S3-compatible AWS SDK v2 client. Stored objects are
referenced by key only; URLs are rebuilt from those keys (plus `S3_HOST`) via
`utils` at read time — nothing in the DB stores a full URL.

**Bucket CORS is mandatory** for full media-player functionality: the bucket
itself must return `Access-Control-Allow-Origin` for the frontend's
origin(s), or cross-origin audio/video silently goes mute the moment the
equalizer/booster/visualizer is toggled on (see
[`frontend.md`](frontend.md#web-audio--cross-origin-attachments) for why).
This can't be fixed from application code — it's bucket configuration, out
of band (e.g. `aws s3api put-bucket-cors` against the Yandex endpoint):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://hyorward.tech", "https://www.hyorward.tech"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

(The domain in this example is the project's actual production deployment —
adjust it to your own origins.)

## Web Push

1. Generate a VAPID key pair: `make genvapid`.
2. Set the `push:` config block (see the table above) with `enabled: true`
   and the generated keys.
3. Rebuild/restart the backend. `GET /api/v1/push/public-key` returning
   `404` is the frontend's expected "push unavailable" signal whenever
   `push.enabled` is `false` — not a bug to chase.

Migrations `019`–`021` (`sql/schema/`; `11`–`13` in `sql/init/`) add
mentions, notification settings, and push subscriptions respectively.

## Production routing

- The frontend container is published only on `127.0.0.1:8081:80` — public
  traffic is expected to arrive through a **host** Nginx, not the container
  directly.
- `frontend/nginx.conf` proxies `/api/` to the backend and, for backward
  compatibility with older frontend builds, rewrites `/api/v1/auth/*` to
  `/api/v1/*`.
- `VITE_WS_URL` is an optional override when the WS URL can't be correctly
  derived from `VITE_API_URL` (see [`frontend.md`](frontend.md)).
- **nginx's WS proxy timeout must stay above the server's ping interval**:
  the hub pings every 25s (`internal/service/server/client.go`), so
  `proxy_read_timeout`/`proxy_send_timeout` need real headroom above that —
  the shipped config uses 120s. Get this wrong and idle voice calls get
  dropped by the proxy mid-call. See [`architecture.md`](architecture.md#the-hub-internalserviceserver).

## Origin allow-lists

Two separate origin lists exist and are checked independently:

- `http_server.cors_allowed_origins` — general REST CORS.
- `http_server.ws_allowed_origins` — checked only on the `/server/ws`
  upgrade request.

They're kept separate because a browser's CORS preflight and its WebSocket
upgrade are different mechanisms with no shared enforcement point in Fiber —
a single combined list would either be too permissive for one or too strict
for the other.

## `make deploy`

`scripts/deploy.sh` pulls the target ref on the server over SSH, rebuilds
with `docker compose`, health-checks `backend`+`frontend` on localhost, and
rolls back to the previous commit if the health check fails. `DEPLOY_TARGET`
/ `DEPLOY_PATH` / `DEPLOY_KEY` come from the gitignored `local.env` rather
than being checked into the Makefile — the server address is intentionally
not committed to the repo. Run `scripts/deploy.sh -h` for the full flag list.

`.github/workflows/ci.yml` only builds and tests the Go module and the
`frontend/` project — it does not build Docker images, push anywhere, or
run `scripts/deploy.sh` (which isn't even in git). Deploying is still this
manual, SSH-driven step; there is no CD. Also note the root `Dockerfile`'s
`COPY config/ ./config/` can't succeed on a fresh clone since `config/` is
gitignored — the production checkout works only because `config/prod.yaml`
was placed there by hand once, outside of git.
