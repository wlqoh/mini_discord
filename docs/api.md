# API reference

> Authoritative: `internal/**/routes.go` and `types/websocket.go`.
> Payload shapes: `go doc github.com/wlqoh/mini_discord.git/types`

This is an index, not the payload spec — field-level shapes live in godoc on
the `types` package (kept complete by `make doc-check`). What's here is
enough to know what exists and where to look next.

## REST

Base path: `/api/v1`.

| Method | Path | Auth | Rate limit |
|---|---|---|---|
| POST | `/register` | — | 5/min, burst 5 |
| POST | `/login` | — | 5/min, burst 5 |
| POST | `/verify-email` | — | 5/min, burst 5 |
| POST | `/resend-verification` | — | 5/min, burst 5 |
| POST | `/tokens/renew` | refresh token (body) | 5/min, burst 5 |
| POST | `/updateUser` | JWT | 5/min, burst 5 |
| DELETE | `/deleteUser` | JWT | 5/min, burst 5 |
| GET | `/getAvatar` | JWT | — |
| POST | `/setAvatar` | JWT | 10/min, burst 5 |
| POST | `/upload` | JWT | 10/min, burst 5 |
| GET | `/server/ws` | JWT (cookie `jwt` or `?token=`) | — |
| GET | `/notifications/settings` | JWT | — |
| PATCH | `/notifications/settings` | JWT | 2/s, burst 10 |
| PUT | `/notifications/settings/server/:id` | JWT | 2/s, burst 10 |
| PUT | `/notifications/settings/channel/:id` | JWT | 2/s, burst 10 |
| GET | `/push/public-key` | — | — |
| POST | `/push/subscribe` | JWT | 2/s, burst 10 |
| POST | `/push/unsubscribe` | JWT | 2/s, burst 10 |
| GET | `/embeds/image/:token` | — (see note below) | 20/s, burst 60 |
| GET | `/webrtc/turn-credentials` | JWT | — |
| GET | `/admin/sfu/rooms` | HTTP Basic (`http_server.user`/`password`) | — |

Notes:

- `/embeds/image/:token` is deliberately **not** JWT-gated: an `<img src>`
  can't send an `Authorization` header, and putting a token in the query
  string would leak it into `Referer` headers and access logs. It's safe
  anyway — the endpoint only proxies a URL already resolved into
  `link_previews`, gated by a random 128-bit token, not by arbitrary input.
- `GET /push/public-key` returns `404` whenever `push.enabled` is `false` (or
  no public key is configured) — this is the frontend's intended signal that
  push is unavailable, not a bug.

Request/response bodies are spelled out below only where they aren't
self-evident from the path; everything else is a plain `types.*` struct — see
godoc.

**POST /register**
```json
{ "first_name": "...", "last_name": "...", "email": "...", "password": "..." }
```
→ `201` `{ "message": "..." }` — registration also triggers an async
verification email (`internal/service/mailer`); login is rejected with `403`
until the account is verified.

**POST /login**
```json
{ "email": "...", "password": "..." }
```
→ `200` `types.LoginUserResponse` — both an access and a refresh JWT, their
expiry timestamps, and a `user` summary.

**POST /tokens/renew**
```json
{ "refresh_token": "..." }
```
→ `200` `types.RenewAccessTokenResponse` — a fresh access token.

**POST /verify-email**
```json
{ "token": "..." }
```
Token comes from the verification email link (`{frontend_base_url}/verify-email?token=...`).

**POST /upload** — `multipart/form-data`, field `file` (max 10MB; images,
video, or audio only — see `isAllowedMediaType` in
`internal/service/user/routes.go`). Response:
```json
{ "attachment_id": 123, "url": "https://..." }
```
The file is already in S3 at this point, but the message row doesn't exist
yet — see the attachment flow below.

## WebSocket

Single endpoint: `GET /api/v1/server/ws`.

**Envelope.** Client → server: `types.WsCommand{action, payload, request_id}`.
Server → client: `types.WsEvent{event, data, request_id}`. `request_id` lets
the client correlate an out-of-order response to the command that triggered
it; commands whose handler runs off the `Hub.Run` loop are the only ones that
can actually arrive out of order, so older commands can safely omit it.
`sfu_error` exists as its own event (distinct from the generic `error` event)
because `sfu_candidate` is sent fire-and-forget, outside the request/ack
flow — an error for it can't be blamed on any particular in-flight request.

**Authentication.** JWT via the `jwt` cookie or a `?token=` query param —
**not** an `Authorization` header (browsers can't set custom headers on a WS
upgrade request). Origin is checked separately from REST CORS, against
`http_server.ws_allowed_origins` (see [`architecture.md`](architecture.md)).

### Actions

| Action | Payload | Response | Broadcast? | Rate-limited? |
|---|---|---|---|---|
| `create_server` | `WsCreateServerRequest` | ack | — | 5/min, burst 5 |
| `delete_server` | `WsDeleteServerRequest` | ack | to members | — |
| `join_server` | `WsJoinServerRequest` | ack | — | — |
| `create_channel` | `WsCreateChannelRequest` | ack | to members | 5/min, burst 5 |
| `delete_channel` | `WsDeleteChannelRequest` | ack | to members | — |
| `send_message` | `WsSendMessageRequest` | ack | `message` to channel | 1/s, burst 1 |
| `delete_message` | `WsDeleteMessageRequest` | ack | to channel | — |
| `edit_message` | `WsEditMessageRequest` | ack | `message_edited` to channel | — |
| `get_messages` | `WsGetMessagesRequest` | messages page | — | — |
| `get_messages_around` | `WsGetMessagesAroundRequest` | `WsGetMessagesAroundResponse` | — | — |
| `get_messages_after` | `WsGetMessagesAfterRequest` | messages page | — | — |
| `search_messages` | `WsSearchMessagesRequest` | `WsMessageSearchHit[]` | — | — |
| `get_servers` | — | server list | — | — |
| `get_server_channels` | — | channel list | — | — |
| `get_server_members` | — | `WsServerMember[]` | — | — |
| `get_users_online` | — | user ID list | — | — |
| `get_user_info` | `WsGetUserInfoRequest` | `WsGetUserInfoResponse` | — | — |
| `search_servers` | — | server list | — | — |
| `get_unread` | — | `WsChannelUnread[]` | — | — |
| `mark_read` | — | ack | — | 2/s, burst 10 |
| `typing_start` | — | — | `typing_start` to channel | — |
| `typing_stop` | — | — | `typing_stop` to channel | — |
| `change_voice_status` | `WsChangeVoiceStatusRequest` | — | `voice_status_changed` | — |
| `join_voice_channel` | — | see [`voice.md`](voice.md) | `voice_user_joined` | — |
| `leave_voice_channel` | — | ack | `voice_user_left` | — |
| `sfu_offer` / `sfu_answer` / `sfu_candidate` | see [`voice.md`](voice.md) | see [`voice.md`](voice.md) | — | — |
| `sfu_subscribe_video` | see [`voice.md`](voice.md) | — | — | — |
| `sfu_resume` | see [`voice.md`](voice.md) | see [`voice.md`](voice.md) | `voice_user_resumed` | — |
| `sfu_publish_state` | see [`voice.md`](voice.md) | — | `sfu_track_published`/`unpublished` | — |

### Events

| Event | Data | When |
|---|---|---|
| `ack` | action-specific | a command succeeded |
| `error` | error message | a command failed |
| `connected` | — | just after WS upgrade |
| `message` | `WsMessage` | a new message was sent to a channel you're in |
| `message_edited` | `WsMessageEditedEvent` | a message you can see was edited |
| `message_embeds` | link-preview data | a preview finished resolving asynchronously |
| `typing_start` / `typing_stop` | user ID | someone in the channel started/stopped typing |
| `voice_user_joined` / `voice_user_left` | user/channel info | voice membership changed |
| `voice_status_changed` | `WsChangeVoiceStatusRequest`-shaped | mic/deafen toggled |
| `voice_user_detached` / `voice_user_resumed` | user info | see [`voice.md`](voice.md) — reconnect grace period |
| `sfu_offer` / `sfu_answer` / `sfu_candidate` | SDP/ICE | see [`voice.md`](voice.md) |
| `sfu_track_published` / `sfu_track_unpublished` | track info | see [`voice.md`](voice.md) |
| `sfu_active_speakers` | user ID list | see [`voice.md`](voice.md) |
| `sfu_error` | error message | an `sfu_candidate` (fire-and-forget) failed |
| `sfu_session_closed` | `WsSfuSessionClosedEvent` | sent only to the affected user — the server tore down *their own* SFU session; see [`voice.md`](voice.md) — ghost-session cleanup |

### Flows that don't show up in the type table

1. **Attachments.** `POST /upload` stores the uploaded file in S3 and
   returns an `attachment_id` for a `PendingAttachment` held **in the hub's
   memory** (not the database). The client then sends `send_message` with
   `attachment_ids` referencing it; the hub persists the message and its
   attachments atomically and consumes the pending record. This means
   attachment state genuinely lives in the running process between the two
   requests — an uploaded-but-never-sent file just sits as an orphaned
   in-memory record (and an orphaned S3 object) until the process restarts.
2. **Unread tracking.** `get_unread` returns every channel with unread
   messages and their counts; `mark_read` advances the caller's read cursor
   for a channel (never backward) into the `channel_reads` table.
3. **Search.** `search_messages` runs full-text search (Postgres, migration
   `023`/`sql/init/15`) scoped to either one channel or every text channel in
   a server. `get_messages_around` jumps straight to a two-sided window
   around an arbitrary message (a search hit, a reply target, a push
   notification) without paging backward from the live tail;
   `get_messages_after` then pages forward from that window back down to the
   present. Cursors for both directions are opaque strings
   (`OlderCursor`/`NewerCursor`, with matching `HasMoreOlder`/`HasMoreNewer`
   flags).
4. **Mentions → push.** A mention is detected server-side when the message is
   saved (`SaveMessageMentions`) and bypasses the push aggregation window
   entirely — see [`architecture.md`](architecture.md#notifications-pipeline).
5. **Typing indicators** are purely ephemeral — `typing_start`/`typing_stop`
   are broadcast and forgotten, nothing is persisted.
6. **Voice** — `join_voice_channel`, `leave_voice_channel`, and every `sfu_*`
   action/event are only listed above; the full signaling flow, the
   publish-slot model, and reconnect semantics are in
   [`voice.md`](voice.md).
