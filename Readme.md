# Mini Discord

REST API сервер на Go — бэкенд для мини-версии Discord с регистрацией, аутентификацией пользователей и JWT-авторизацией.

## Технологии

- **Go 1.25+**
- **Chi** — HTTP-роутер
- **PostgreSQL 18** — база данных
- **JWT** — аутентификация (`golang-jwt`)
- **bcrypt** — хеширование паролей
- **Goose** — миграции базы данных
- **cleanenv** — конфигурация из YAML
- **validator** — валидация входных данных

## Структура проекта

```
├── cmd/discord_go/        # Точка входа приложения
├── config/                # Конфигурационные файлы (YAML)
├── internal/
│   ├── config/            # Загрузка конфигурации
│   ├── lib/
│   │   ├── api/           # HTTP-сервер и маршрутизация
│   │   └── logger/sl/     # Хелперы для логирования
│   ├── service/
│   │   ├── auth/          # JWT-токены и хеширование паролей
│   │   └── user/          # Хендлеры и хранилище пользователей
│   └── storage/
│       └── postgresql/    # Подключение к PostgreSQL
├── sql/schema/            # SQL-миграции (Goose)
├── types/                 # Типы данных и интерфейсы
├── utils/                 # Утилиты (JSON, валидация)
└── tests/                 # Тесты
```

## Требования

- Go 1.25+
- Docker (для PostgreSQL)
- [Goose](https://github.com/pressly/goose) (для миграций)

## Установка и запуск

### 1. Клонируйте репозиторий

```bash
git clone https://github.com/wlqoh/mini_discord.git
cd mini_discord
```

### 2. Запустите PostgreSQL в Docker

```bash
docker run -d \
  --name postgres_db \
  -e POSTGRES_USER=murad \
  -e POSTGRES_PASSWORD=123 \
  -p 5432:5432 \
  postgres:18
```

### 3. Настройте конфигурацию

Создайте файл `local.env`:

```env
CONFIG_PATH=./config/local.yaml
DB_URL=postgres://murad:123@localhost:5432/postgres?sslmode=disable
```

Создайте файл `config/local.yaml`:

```yaml
env: "local"
storage_path: "postgres://murad:123@localhost:5432/postgres?sslmode=disable"
http_server:
  host: "localhost:8080"
  timeout: 4s
  idle_timeout: 60s
  user: "myuser"
  password: "mypass"
jwt_secret: "your-secret-key"
jwt_expiration_in_seconds: 604800
```

### 4. Примените миграции

```bash
make up
```

### 5. Запустите сервер

```bash
make run
```

Сервер запустится на `localhost:8080`.

### 2.5. Если запускаете через docker-compose

Теперь в `docker-compose.yml` есть сервис `migrate`, который при каждом `docker compose up`
применяет SQL-скрипты из `sql/init` (`01_users.sql` и `02_chat_schema.sql`).
Это закрывает кейс с уже существующим volume, где стандартный `/docker-entrypoint-initdb.d`
у Postgres больше не выполняется.

Запуск:

```bash
docker compose up -d --build
```

Проверка, что таблицы созданы:

```bash
docker compose exec db psql -U murad -d postgres -c "\\dt"
```

Если после обновления compose-файла контейнеры уже были запущены, перезапустите стек:

```bash
docker compose down
docker compose up -d --build
```

### Production routing notes

- Frontend container is published only to localhost: `127.0.0.1:8081:80`.
- Public traffic should go through host Nginx.
- API requests are expected under `/api/*`.
- For backward compatibility, `/api/v1/auth/*` is rewritten to `/api/v1/*` in `frontend/nginx.conf`.

## Voice/Video channels (WebRTC via SFU)

- Calls use the same websocket endpoint: `/api/v1/server/ws`.
- Channel types:
  - `text` for chat
  - `voice` for voice/video rooms
- Voice runs through a server-side SFU (`internal/service/sfu/`, Pion-based): each client
  holds a single `RTCPeerConnection` to the server, which forwards published tracks to
  subscribers — there is no peer-to-peer mesh.
- Signaling actions over websocket:
  - `join_voice_channel` — returns `transport_mode: "sfu"`, a `session_id`, ICE servers, and
    the fixed publish-slot declarations (mic/camera/screen/screen_audio)
  - `leave_voice_channel`
  - `sfu_offer` / `sfu_answer` / `sfu_candidate` — SDP/ICE exchange with the SFU (server is
    always the offerer after the client's initial offer)
  - `sfu_subscribe_video` — explicit opt-in to receive a given participant's video (audio is
    auto-subscribed on publish)
  - `sfu_resume` — reattaches an existing SFU session after a brief websocket reconnect,
    without tearing down media
- A short-lived debug snapshot of active rooms is available at
  `GET /api/v1/admin/sfu/rooms` (same HTTP Basic Auth as `http_server.user`/`password`).

### Frontend env for WebRTC

```bash
VITE_API_URL=/api/v1
VITE_WEBRTC_STUN_URLS=stun:stun.l.google.com:19302
VITE_WEBRTC_TURN_URLS=turn:turn.your-domain.com:3478?transport=udp,turn:turn.your-domain.com:3478?transport=tcp,turns:turn.your-domain.com:5349?transport=tcp
VITE_WEBRTC_TURN_USERNAME=mini_discord
VITE_WEBRTC_TURN_CREDENTIAL=change-me
# optional debug switch (forces TURN relay only)
VITE_WEBRTC_FORCE_RELAY=false
```

For docker-compose production build, export the same `VITE_*` variables in shell (or `.env`) before running:

```bash
docker compose up -d --build
```

## Notifications (sound + browser + Web Push)

- **Sound & in-app notifications** work out of the box for any logged-in session — no config needed. They cover the tab-open case (WS-live) and are governed by per-user settings under `REST /api/v1/notifications/settings` (default level, per-server/per-channel overrides, mute, Do Not Disturb, hide-preview).
- **Web Push** (notifications while the tab is closed) requires a VAPID key pair and is disabled by default. To enable it:

  1. Generate a key pair:
     ```bash
     make genvapid
     ```
  2. Add the printed keys to `config/local.yaml` (or the prod config):
     ```yaml
     push:
       enabled: true
       vapid_public_key: "<public key>"
       vapid_private_key: "<private key>"
       vapid_subject: "mailto:admin@example.com"
       ttl_seconds: 43200
     ```
  3. Rebuild/restart the backend. `GET /api/v1/push/public-key` returns `404` whenever `push.enabled` is `false` — the frontend treats that as "push unavailable" and silently falls back to sound + in-tab notifications only.

- **Testing the Service Worker locally**: the dev server only registers `public/sw.js` when `VITE_ENABLE_SW=true` is set (production builds always register it) — without it, push and background notifications can't be exercised in `npm run dev`:
  ```bash
  VITE_ENABLE_SW=true npm run dev
  ```
- Push delivery uses a small worker pool with a ~10s aggregation window per `(user, channel)` so a burst of ordinary messages collapses into one notification; mentions bypass the window and send immediately with high urgency. See `internal/service/push/`.
- Migrations `019`–`021` (`sql/schema/`, mirrored without goose markers in `sql/init/`) add mentions, notification settings, and push subscriptions respectively.

Example file: `frontend/.env.production.example`.

### Required TURN setup for stable production calls

Without TURN, calls can work inconsistently across different ISPs/NATs (exactly the case when VPN helps some users).

1. Set TURN variables in your deployment `.env`:

```bash
TURN_REALM=your-domain.com
TURN_PUBLIC_IP=YOUR_SERVER_PUBLIC_IP
TURN_USERNAME=mini_discord
TURN_PASSWORD=strong-turn-password
TURN_TLS_PORT=5349
TURN_TLS_CERT_FILE=/etc/coturn/certs/fullchain.pem
TURN_TLS_KEY_FILE=/etc/coturn/certs/privkey.pem
TURN_MIN_PORT=49160
TURN_MAX_PORT=49260

VITE_WEBRTC_TURN_URLS=turn:your-domain.com:3478?transport=udp,turn:your-domain.com:3478?transport=tcp,turns:your-domain.com:5349?transport=tcp
VITE_WEBRTC_TURN_USERNAME=mini_discord
VITE_WEBRTC_TURN_CREDENTIAL=strong-turn-password
VITE_WEBRTC_FORCE_RELAY=false
```

2. Open firewall ports on the host:

- `3478/tcp`
- `3478/udp`
- `5349/tcp`
- `49160-49260/udp`
- `49160-49260/tcp`

3. Put certificates for coturn to `deploy/coturn/certs/`:

- `deploy/coturn/certs/fullchain.pem`
- `deploy/coturn/certs/privkey.pem`

For highly restrictive networks (some VPN/corporate/mobile providers), TURN over UDP can still be blocked. In that case, keep `transport=tcp` in `VITE_WEBRTC_TURN_URLS` and temporarily set `VITE_WEBRTC_FORCE_RELAY=true` to validate that relay path is healthy.

4. Rebuild and restart:

```bash
docker compose down
docker compose up -d --build
```

Optional websocket override:

```bash
VITE_WS_URL=wss://your-domain.com/api/v1/server/ws
```

Quick check after deploy (logs should show allocations when users join calls):

```bash
docker compose logs -f turn
```

### Origin allow-lists

Configure allowed browser origins in backend config:

- `http_server.cors_allowed_origins`
- `http_server.ws_allowed_origins`

## Link previews

Сообщение со ссылкой получает карточку с метаданными страницы (Open Graph / Twitter Card / `<title>`).

- Метаданные забирает бэкенд (`internal/service/embed/`) **асинхронно**, воркер-пулом: горутина `Hub.Run()` последовательна и не может ждать внешний сайт. Готовое превью прилетает отдельным WS-событием `message_embeds`, фронт домёрживает его в сообщение по `message_id`.
- Превью делается только для **первой** подходящей ссылки в сообщении. Ссылки на собственный фронтенд и на S3-бакет пропускаются.
- Кэш трёхуровневый: память (`internal/storage/cache`) → `link_previews` в Postgres → сеть. Параллельные запросы одного URL схлопываются через `single_flight`. Неудачные фетчи кэшируются отдельным, более коротким TTL.
- Картинка `og:image` **проксируется** через `GET /api/v1/embeds/image/:token`, чтобы IP пользователей не утекали на чужие сайты. Токен случайный (128 бит) и хранится в `link_previews.image_token`; сырой URL наружу не отдаётся. `image/svg+xml` отклоняется.
- SSRF закрыт на уровне сокета: `DialContext` отклоняет приватные, loopback, link-local (включая `169.254.169.254`) и CGNAT-адреса и разрешает только порты 80/443. Проверка идёт по фактическому IP, поэтому устойчива к DNS-rebinding и повторяется на каждом редиректе.
- Превью получают только сообщения, отправленные после включения фичи: бэкфилла истории нет.

Настройки — блок `link_preview` в конфиге (включён по умолчанию):

```yaml
link_preview:
  enabled: true
  timeout: 5s
  max_body_bytes: 524288
  max_image_bytes: 2097152
  max_redirects: 3
  cache_ttl: 168h
  negative_cache_ttl: 6h
  workers: 4
  user_agent: "MiniDiscordBot/1.0 (+link preview)"
```

Миграция `022` (`sql/schema/`, зеркало без goose-маркеров в `sql/init/14_link_previews.sql`) добавляет таблицы `link_previews` и `message_embeds`.

## Media Player (frontend)

Audio message attachments render with a custom, reusable player instead of the bare native `<audio>` control.

**Files:**

- `frontend/src/types/media.ts` — `Track`, `PlayerState`, `EqualizerBand`, `LoopMode` types. `PlayerState.volume` (0..1) and `PlayerState.boost` (1..2) are independent fields — boost is an extra Web-Audio gain multiplier on top of volume, not a second interpretation of the same number.
- `frontend/src/hooks/useMediaPlayer.ts` — headless playback hook: owns an `<audio>` ref, playback state (play/pause/seek/volume/boost/rate/loop/shuffle), a lazily-created Web Audio graph (5-band equalizer + analyser + gain boost), and DOM event wiring (`timeupdate`, `loadedmetadata`, `ended`, `error`, `progress`). By default all instances on a page share one lazily-created `AudioContext` (module-level singleton) instead of one each, since browsers such as Safari cap concurrent AudioContexts — pass `audioContext` to opt into a different shared context (e.g. from a call) instead.
- `frontend/src/services/playlistService.ts` — `shuffleTracks` (Fisher-Yates), `getNextIndex`/`getPreviousIndex` for advancing the queue, and `addToHistory` (`localStorage`-backed playback history).
- `frontend/src/components/MediaPlayer.tsx` — the UI: transport controls, interactive seek bar with hover time preview (available in both expanded and mini mode), volume slider + mute, playback-speed dropdown, loop-mode cycling, shuffle, a collapsible equalizer/volume-boost/spectrum-visualizer panel, a queue panel, and a mini/compact mode. Mini mode keeps the seek bar, mute, and volume controls, and surfaces playback errors as a small alert icon (with the message as a tooltip/accessible name) next to the track title. Keyboard shortcuts (when the player has focus): `Space` play/pause, `M` mute, `←`/`→` seek ±5s.
- `frontend/src/styles/mediaPlayer.css` — styling, reusing the `chat.css` design tokens (`--glass-*`, `--accent*`, `--text-*`, `--radius-*`) so it matches the dark/light theme automatically.

**Usage:**

```tsx
import MediaPlayer from "./components/MediaPlayer";
import type { Track } from "./types/media";

const tracks: Track[] = [
  { id: 1, title: "Song A", artist: "Artist", duration: 0, url: "https://.../a.mp3" },
  { id: 2, title: "Song B", artist: "Artist", duration: 0, url: "https://.../b.ogg" },
];

<MediaPlayer
  tracks={tracks}
  compact={false}        // start expanded (true = mini/now-playing bar)
  showPlaylist={true}    // queue panel toggle
  showEqualizer={true}   // EQ + volume-boost panel toggle
  showVisualizer={true}  // spectrum visualizer toggle
  audioContext={sharedCtx} // optional: reuse an AudioContext (e.g. from a call) instead of the default shared one
/>
```

The equalizer/visualizer/volume-boost only create a `MediaElementAudioSourceNode` graph the first time they're actually toggled on, so a plain playback session never pays for Web Audio setup. If `AudioContext` is unavailable, playback still works through the native `<audio>` element.

**Chat integration:** `MessageList.tsx` renders an `<AudioAttachment>` wrapper per audio attachment (mapped from `Attachment` via `guessFormatFromContentType`, memoized so the `tracks` array stays referentially stable across unrelated message-list re-renders) around `<MediaPlayer tracks={tracks} compact showPlaylist={false} />`, starting collapsed as a now-playing bar the user can expand.

### Video player

- `frontend/src/components/VideoPlayer.tsx` — reuses `useMediaPlayer<HTMLVideoElement>` (the hook is generic over the media element type) around a visible `<video>` element instead of a hidden `<audio>` one. Controls (play/pause, seek bar with hover preview, volume + mute, playback speed, fullscreen, Picture-in-Picture) render as an overlay bar that auto-hides after ~2.5s of inactivity while playing, and stays visible while paused. Keyboard shortcuts: `Space` play/pause, `M` mute, `F` fullscreen, `←`/`→` seek ±5s.
- `frontend/src/styles/videoPlayer.css` — dark/translucent overlay chrome (video content itself sets the backdrop, so this doesn't reuse `chat.css`'s glass-surface tokens, only `--accent*`/`--radius-*`).
- **Chat integration:** `MessageList.tsx`'s `VideoAttachment` wrapper mirrors `AudioAttachment` (same memoized single-track mapping) around `<VideoPlayer tracks={tracks} />`.

### Web Audio + cross-origin attachments — required bucket CORS

Both `<audio crossOrigin="anonymous">` (MediaPlayer) and `<video crossOrigin="anonymous">` (VideoPlayer) route through `createMediaElementSource` once the equalizer, volume boost, or spectrum visualizer is enabled. Per the Web Audio spec, an element's audio is silently zeroed once piped through the graph if the underlying resource is cross-origin and wasn't loaded in CORS mode with permission from the server (this is a security measure, not an error — no exception is thrown, playback just goes silent the moment those features are toggled on).

Since attachments are served straight from the Yandex Object Storage bucket (`S3HOST`, see below), **the bucket itself must return `Access-Control-Allow-Origin` for the app's origin(s)** — this can't be fixed from application code alone. Bucket CORS is configured out-of-band (e.g. via `boto3`/`aws s3api put-bucket-cors` against the Yandex Object Storage S3-compatible endpoint), not from this repo. A rule like the following is sufficient:

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

Without this, plain playback still works fine (no CORS involved for normal `<audio>`/`<video>` fetches), but toggling the equalizer/boost/visualizer goes silent.

## API Эндпоинты

Базовый путь: `/api/v1`

### Регистрация

```
POST /api/v1/register
```

**Body:**

```json
{
  "first_name": "Ivan",
  "last_name": "Ivanov",
  "email": "ivan@example.com",
  "password": "secret123"
}
```

**Ответ:** `201 Created`

```json
{
  "status": "ok"
}
```

### Авторизация

```
POST /api/v1/login
```

**Body:**

```json
{
  "email": "ivan@example.com",
  "password": "secret123"
}
```

**Ответ:** `200 OK`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

## Makefile команды

| Команда      | Описание                        |
|--------------|---------------------------------|
| `make build` | Сборка бинарного файла          |
| `make run`   | Сборка и запуск сервера         |
| `make up`    | Применить миграции БД (goose)   |
| `make down`  | Откатить миграции БД (goose)    |
| `make genvapid` | Сгенерировать пару VAPID-ключей для Web Push |

## Окружения

Приложение поддерживает три режима работы через параметр `env` в конфигурации:

| Окружение | Уровень логов |
|-----------|---------------|
| `local`   | Debug (JSON)  |
| `dev`     | Debug (JSON)  |
| `prod`    | Info (JSON)   |

## Лицензия

MIT

