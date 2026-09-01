# Frontend

> Authoritative: `frontend/src/`

## Layout

`ChatPage.tsx` (~1.3k lines) is the app's single composed screen — there's no
router-driven page split for the chat UI itself. Almost all logic lives in
`hooks/`, not the page. **The rule for contributors: extend or add a hook,
don't grow the page.**

The 16 hooks, one line each:

- `useDocumentBadge` — updates the tab's favicon/title badge with unread count
- `useJumpToLatest` — "scroll to latest message" affordance state
- `useMediaPlayer` — headless audio/video playback (see below)
- `useMediaQuery` — responsive breakpoint reads
- `useMessageSearch` — drives `search_messages`/`get_messages_around` for in-chat search
- `useMessages` — message list state, pagination, send/edit/delete
- `useNotificationContextMenu` — the right-click menu for per-channel/server notification overrides
- `useNotificationSettings` — REST `notifications/settings` CRUD
- `useNotifications` — should-notify decisions, sound, browser notifications, leader election
- `useProfile` — current user profile state (name, nickname, avatar)
- `useServerMembers` — member list for the active server
- `useServers` — server/channel list, create/join/delete
- `useTypingEmitter` — sends `typing_start`/`typing_stop` while composing
- `useTypingIndicator` — renders incoming typing events
- `useUnread` — `get_unread`/`mark_read` state
- `useVoice` — voice/video call state, wraps `SfuCallClient`

## Services — the backend contract

- **`chatSocket.ts`** (`ChatSocket` class) — the one WebSocket connection:
  a serialized command queue with a 10s timeout, `request_id` correlation
  for out-of-order responses, autoreconnect, and a typed listener set per
  event. `resolveWsUrl` prefers `VITE_WS_URL`; otherwise it derives the WS
  URL from `VITE_API_URL`. The JWT goes over as a `?token=` query
  parameter — the WS upgrade path doesn't accept an `Authorization` header
  (see [`api.md`](api.md)).
- **`sfuCallClient.ts`** (`SfuCallClient`) implements the `VoiceClient`
  interface declared in `voiceClient.ts`. Call sites (`useVoice`,
  `ChatPage`) depend only on that interface, never on the concrete class —
  useful if a mesh or alternate transport is ever reintroduced.
- **`localCapture.ts`** — `getUserMedia` plus a user-selectable noise
  suppression mode: `off` (echo cancellation only), `browser` (the browser's
  built-in WebRTC noise suppression/AGC), or `rnnoise` (RNNoise via
  `@sapphi-red/web-noise-suppressor`, run through a `DynamicsCompressorNode`
  + makeup-gain chain since the rnnoise constraints profile disables the
  browser's own AGC). The desired mode is persisted device-locally
  (`voiceSettings.ts`, `localStorage` key `voice_noise_suppression`) and can
  differ from the *effective* mode reported back to the UI, e.g. when RNNoise
  isn't supported or a watchdog falls back after the RNNoise `AudioContext`
  gets stuck suspended — see `docs/voice.md`'s noise suppression section.
  Media is always acquired **before** `join_voice_channel` is sent, so the
  join ack and local capture aren't racing each other.
- **`notifications/`**:
  - `rules.ts` — the should-notify decision (level, mute, DND, mentions)
  - `leader.ts` — `BroadcastChannel`-based leader election, so exactly one
    open tab plays the notification sound
  - `push.ts` — Web Push subscribe/unsubscribe against the REST endpoints
  - `sound.ts` — the actual audio playback
  - `permission.ts` — browser notification permission flow
- **Other services**: `chatApi.ts`, `avatarApi.ts`, `turnApi.ts`,
  `authToken.ts`, `connectionQuality.ts`, `webrtcShared.ts`,
  `playlistService.ts` (shuffle/queue/history for the media player),
  `notificationsApi.ts`.

## Media players

- `useMediaPlayer` is a headless hook, generic over the media element type
  (`useMediaPlayer<HTMLAudioElement>` for audio, `useMediaPlayer<HTMLVideoElement>`
  for video) — `VideoPlayer.tsx` reuses the exact same hook `MediaPlayer.tsx`
  (audio) does, just around a visible `<video>` instead of a hidden
  `<audio>`.
- The Web Audio graph (5-band equalizer + spectrum analyser + gain boost) is
  created **lazily**, only the first time one of those features is actually
  toggled on — a plain playback session never pays for Web Audio setup.
- A single `AudioContext` is a **module-level singleton**, shared by every
  player instance on the page by default, because browsers (notably Safari)
  cap the number of concurrent `AudioContext`s. An `audioContext` prop lets
  a caller supply a different shared context instead — e.g. reusing the
  call's own context during a voice session.
- `PlayerState.volume` (0..1) and `PlayerState.boost` (1..2) are
  **independent** fields, not two views of the same number: boost is an
  additional Web Audio gain multiplier stacked on top of volume, not a
  second way to express volume.

### Web Audio + cross-origin attachments

Both `<audio crossOrigin="anonymous">` and `<video crossOrigin="anonymous">`
route through `createMediaElementSource` once the equalizer, volume boost, or
spectrum visualizer is switched on. Per the Web Audio spec, if the
underlying resource is cross-origin and wasn't served with CORS permission
for the page's origin, the element's audio is **silently zeroed** the moment
it's piped through that graph — no exception is thrown, playback just goes
silent exactly when one of those features is toggled on. Plain playback
(no equalizer/boost/visualizer) is unaffected either way, since it never
touches `createMediaElementSource`.

Since attachments are served straight from the S3-compatible bucket, this
means **the bucket itself must return `Access-Control-Allow-Origin`** for
the app's origin — see [`deployment.md`](deployment.md#s3--yandex-object-storage)
for the actual CORS rule. Nothing in this repo can fix a missing bucket CORS
header from the application side.

## Frontend env vars

| Var | Purpose |
|---|---|
| `VITE_API_URL` | REST base URL, e.g. `http://localhost:8080/api/v1` or `/api/v1` behind a reverse proxy |
| `VITE_WS_URL` | Optional explicit WS URL override; otherwise derived from `VITE_API_URL` |
| `VITE_WEBRTC_STUN_URLS` | Comma-separated STUN server list |
| `VITE_WEBRTC_TURN_URLS` | Comma-separated TURN/TURNS server list |
| `VITE_WEBRTC_TURN_USERNAME` / `VITE_WEBRTC_TURN_CREDENTIAL` | Static TURN credentials — leave both unset (recommended) to have the frontend fetch short-lived per-user credentials from `GET /webrtc/turn-credentials` instead |
| `VITE_WEBRTC_FORCE_RELAY` | Diagnostic-only: forces the TURN relay path to validate it's healthy |
| `VITE_ENABLE_SW` | Registers `public/sw.js` in **dev** (`npm run dev`); production builds always register it regardless of this flag. Required to exercise push/background notifications locally: `VITE_ENABLE_SW=true npm run dev` |

## Build & lint

```bash
cd frontend
npm run dev      # vite on :5174, strictPort
npm run build     # tsc -b && vite build
npm run lint      # eslint .
```

**Warning:** `package.json` / `node_modules/` / `package-lock.json` at the
**repository root** are untracked strays unrelated to this project — their
`lint` script points at `../../Downloads`. Ignore them entirely; the real
frontend project is `frontend/` and nowhere else.

## Wire contract

Changing `types/websocket.go` (any `WsAction*`/`WsEvent*` constant or
payload struct) requires manually mirroring the change in
`frontend/src/services/chatSocket.ts` and `frontend/src/types/chat.ts` —
there is no codegen linking the two. See
[`architecture.md`](architecture.md#boundaries-that-must-be-preserved).
