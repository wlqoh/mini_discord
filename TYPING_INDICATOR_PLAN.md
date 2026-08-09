# План: индикатор «X печатает…» (typing indicator)

Фича: детектировать локальную активность ввода в текстовом канале и транслировать её другим
участникам канала через WebSocket, показывая строку «X печатает…» над полем ввода.

Документ самодостаточен: содержит все принятые решения, точные файлы/функции, наброски кода,
константы, крайние случаи и план тестирования. Ссылки на код даны в формате `путь:строка` на
момент составления плана.

---

## 1. Принятые решения (дерево решений)

| # | Решение | Выбор |
|---|---------|-------|
| 1 | Протокол | **Два отдельных экшена** `typing_start` / `typing_stop`, fire-and-forget, **в обход ack-очереди** (как `rtc_signal`) |
| 2 | Роль сервера | **Гибрид**: stateless relay + минимальное состояние `map[userID]channelID`, чтобы при дисконнекте разослать `typing_stop` |
| 3 | Детекция/троттлинг | **Throttle** (`typing_start` не чаще раза в 3 c пока печатают) + **inactivity-таймер** (молчание → `typing_stop`); стоп также при отправке / очистке / потере фокуса |
| 4 | Тайминги | throttle **3 c**, inactivity **5 c**, receiver TTL **6 c** (инвариант `TTL > throttle` с запасом); все — константы |
| 5 | Область/получатели | Только **text**-каналы; рассылка членам канала через `CanUserAccessChannel` + `ListChannelMemberUserIDs`, исключая отправителя |
| 6 | UI | Именной вид с деградацией: 1 → «X печатает…», 2 → «X и Y печатают…», 3 → «X, Y и ещё 1…», ≥4 → «Несколько человек печатают…»; анимированные точки; фиксированная высота-плейсхолдер; имя = `nickname → first_name` |
| 7 | Payload события | **Тонкое** событие `{channel_id, user_id}`; имя резолвит получатель из кэша (online-users / авторы сообщений / `get_user_info`), сервер **не** ходит в БД |

---

## 2. Архитектурный контекст (как есть сейчас)

**Backend (Go / Fiber, пакет `internal/service/server`):**
- `Hub` — один клиент на пользователя: `clientsByUser map[int]*Client` (`hub.go:27`).
- Входящие команды: `Client.readMessage` → канал `Hub.Commands` → `handleCommand` (switch по `Action`,
  `hub.go:149`).
- Рассылка: `pushToUsers(userIDs, event)` (`hub.go:240`), `enqueueEvent` кладёт в `cl.Outbound`
  с `default`-дропом при переполнении (`hub.go:270`).
- Готовый образец fire-and-forget без ack — `relayRTCSignal` (`hub.go:928`): валидирует доступ,
  находит получателей, шлёт событие, **не** отвечает `ack`.
- Дисконнект: `unregisterClient` (`hub.go:133`) — сюда добавим рассылку `typing_stop`.
- Константы экшенов/событий и типы запросов — `types/websocket.go:35-65`.

**Frontend (React + TS):**
- `ChatSocket` (`frontend/src/services/chatSocket.ts`): команды идут через очередь с **одним**
  `pending` + ack (`sendCommand`/`flushQueue`, строки 745, 310). `rtc_signal` намеренно шлётся
  **в обход** очереди прямым `socket.send` (`sendRTCSignal`, строка 730) — тот же приём применим
  к typing.
- Диспетчер входящих событий — `ws.onmessage` (`chatSocket.ts:409`); события `voice_*` / `rtc_signal`
  разбираются здесь и раздаются подписчикам через `Set<Listener>` + `onX()` (строки 519-542).
- Поле ввода — `MessageInput.tsx`; локальный текст в `text`/`setText` (`MessageInput.tsx:62`,
  `onChange` — строка 469), сабмит — `handleSubmit` (строка 297).
- Подписки на сокет и состояние сообщений — хук `useMessages.ts` (образец `onMessage`-подписки —
  строка 38).
- Композиция страницы — `ChatPage.tsx`: `socketRef` (строка 30), `currentUserId` (строка 40),
  `servers.selectedChannelId`, `currentChannel`, рендер `MessageList` (строка 584) и `MessageInput`
  (строка 587). `currentChannel.type` даёт text/voice.

---

## 3. Протокол WebSocket (новые сообщения)

### 3.1 Client → Server (команды)

```jsonc
// typing_start
{ "action": "typing_start", "payload": { "channel_id": 123 } }
// typing_stop
{ "action": "typing_stop",  "payload": { "channel_id": 123 } }
```

### 3.2 Server → Client (события) — тонкий payload (решение 7)

```jsonc
{ "event": "typing_start", "data": { "channel_id": 123, "user_id": 42 } }
{ "event": "typing_stop",  "data": { "channel_id": 123, "user_id": 42 } }
```

Оба направления — fire-and-forget: сервер на команды `typing_*` **не** отправляет `ack`
и **не** отправляет `error` в штатном потоке (тихо игнорирует невалидное — см. 4.2), чтобы не
конфликтовать с ack-очередью на клиенте.

---

## 4. Backend — изменения

### 4.1 `types/websocket.go`

Добавить константы:

```go
// actions
WsActionTypingStart = "typing_start"
WsActionTypingStop  = "typing_stop"
// events
WsEventTypingStart = "typing_start"
WsEventTypingStop  = "typing_stop"
```

Добавить типы:

```go
type WsTypingRequest struct {
    ChannelID int64 `json:"channel_id"`
}

type WsTypingEvent struct {
    ChannelID int64 `json:"channel_id"`
    UserID    int   `json:"user_id"`
}
```

### 4.2 `internal/service/server/hub.go`

**Состояние (решение 2, гибрид).** В структуру `Hub` (рядом с `voiceStatusByUser`, `hub.go:33`)
добавить последний «печатаемый» канал пользователя, под тем же `h.mu`:

```go
typingChannelByUser map[int]int64 // userID -> channelID последнего typing_start
```

Инициализировать в `NewHub` (`hub.go:62`): `typingChannelByUser: make(map[int]int64)`.

**Диспетчеризация.** В `handleCommand` (switch, `hub.go:152`) добавить:

```go
case types.WsActionTypingStart:
    h.handleTyping(req, ctx, true)
case types.WsActionTypingStop:
    h.handleTyping(req, ctx, false)
```

**Обработчик** (по образцу `relayRTCSignal`, `hub.go:928`; **без ack**):

```go
func (h *Hub) handleTyping(req wsCommandRequest, ctx context.Context, start bool) {
    var payload types.WsTypingRequest
    if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
        return // тихо: typing — не критично, ack не шлём
    }
    if payload.ChannelID <= 0 {
        return
    }

    // Доступ проверяем как для send_message (решение 5)
    canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
    if err != nil || !canAccess {
        return
    }

    // Обновляем/чистим минимальное состояние для гашения при дисконнекте
    h.mu.Lock()
    if start {
        h.typingChannelByUser[req.client.UserID] = payload.ChannelID
    } else {
        delete(h.typingChannelByUser, req.client.UserID)
    }
    h.mu.Unlock()

    recipientUserIDs, err := h.storage.ListChannelMemberUserIDs(ctx, payload.ChannelID)
    if err != nil {
        return
    }
    // исключаем самого отправителя
    filtered := recipientUserIDs[:0:0]
    for _, id := range recipientUserIDs {
        if id != req.client.UserID {
            filtered = append(filtered, id)
        }
    }

    event := types.WsEventTypingStart
    if !start {
        event = types.WsEventTypingStop
    }
    h.pushToUsers(filtered, &types.WsEvent{
        Event: event,
        Data:  types.WsTypingEvent{ChannelID: payload.ChannelID, UserID: req.client.UserID},
    })
}
```

**Гашение при дисконнекте** (решение 2). В `unregisterClient` (`hub.go:133`), внутри ветки
`removed`, забрать `channelID` из `typingChannelByUser` и, если был, разослать `typing_stop`:

```go
h.mu.Lock()
typingChannelID, wasTyping := h.typingChannelByUser[cl.UserID]
delete(h.typingChannelByUser, cl.UserID)
h.mu.Unlock()

if wasTyping {
    ctx := context.Background()
    if recipients, err := h.storage.ListChannelMemberUserIDs(ctx, typingChannelID); err == nil {
        filtered := recipients[:0:0]
        for _, id := range recipients {
            if id != cl.UserID {
                filtered = append(filtered, id)
            }
        }
        h.pushToUsers(filtered, &types.WsEvent{
            Event: types.WsEventTypingStop,
            Data:  types.WsTypingEvent{ChannelID: typingChannelID, UserID: cl.UserID},
        })
    }
}
```

> Примечание: `unregisterClient` уже вызывает `close(cl.Outbound)` для отключаемого клиента; рассылка
> идёт **другим** пользователям, их `Outbound` не тронут. Событие для самого себя отфильтровано.

**Нагрузка/дроп.** `typing_*` идёт через обычный `enqueueEvent` с `default`-дропом при
переполнении очереди (`hub.go:280`) — для косметического события это приемлемо (в отличие от
`rtc_signal`, отдельная ветка с таймаутом **не** нужна).

**Троттлинг на сервере не нужен** — клиент уже шлёт `typing_start` не чаще раза в 3 c
(решение 3/4). Существующий `sendMessageLimiter` на typing **не** распространяем.

---

## 5. Frontend — изменения

### 5.1 `frontend/src/types/chat.ts`

```ts
export interface TypingEvent {
    channel_id: number;
    user_id: number;
}
```

### 5.2 `frontend/src/services/chatSocket.ts`

**Отправка (в обход ack-очереди, как `sendRTCSignal`, строка 730):**

```ts
sendTyping(channelId: number, isTyping: boolean): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return; // typing не критичен — молча выходим
    }
    this.socket.send(JSON.stringify({
        action: isTyping ? "typing_start" : "typing_stop",
        payload: { channel_id: channelId },
    }));
}
```

**Приём.** Добавить набор слушателей и `onTyping` (по образцу `onVoiceUserJoined`, строки 524-532):

```ts
type TypingListener = (event: TypingEvent, isTyping: boolean) => void;
private readonly typingListeners = new Set<TypingListener>();

onTyping(listener: TypingListener): () => void {
    this.typingListeners.add(listener);
    return () => this.typingListeners.delete(listener);
}
```

В `ws.onmessage` (`chatSocket.ts:409`) добавить ветки **до** обработки `ack`:

```ts
if (parsed.event === "typing_start" || parsed.event === "typing_stop") {
    const d = parsed.data as TypingEvent;
    if (d && typeof d.channel_id === "number" && typeof d.user_id === "number") {
        const isTyping = parsed.event === "typing_start";
        this.typingListeners.forEach((l) => l(d, isTyping));
    }
    return;
}
```

### 5.3 Константы таймингов (решение 4)

Вынести в один модуль, например `frontend/src/services/typing.ts` (или константы в
`chatSocket.ts`):

```ts
export const TYPING_THROTTLE_MS = 3000;    // как часто повторять typing_start
export const TYPING_INACTIVITY_MS = 5000;  // молчание -> typing_stop (отправитель)
export const TYPING_RECEIVER_TTL_MS = 6000; // авто-скрытие у получателя (страховка)
```

Опционально продублировать значения в Go-константах в `hub.go` (только как ориентир; сервер
таймерами не пользуется).

### 5.4 Хук отправителя: `useTypingEmitter` (новый, `frontend/src/hooks/useTypingEmitter.ts`)

Инкапсулирует throttle + inactivity (решение 3). Возвращает две функции для `MessageInput`.

```ts
import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import { TYPING_THROTTLE_MS, TYPING_INACTIVITY_MS } from "../services/typing.ts";

export function useTypingEmitter(
    socketRef: React.MutableRefObject<ChatSocket | null>,
    channelId: number,
) {
    const lastSentRef = useRef(0);          // время последнего typing_start (throttle)
    const inactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeRef = useRef(false);        // считаем ли мы себя «печатающим»

    const stop = useCallback(() => {
        if (inactivityRef.current) { clearTimeout(inactivityRef.current); inactivityRef.current = null; }
        if (!activeRef.current) return;
        activeRef.current = false;
        lastSentRef.current = 0;
        if (channelId > 0) socketRef.current?.sendTyping(channelId, false);
    }, [socketRef, channelId]);

    // Вызывать на каждый keystroke (onChange). Пустой ввод трактуем как stop.
    const onInput = useCallback((value: string) => {
        if (channelId <= 0) return;
        if (value.trim().length === 0) { stop(); return; }

        const now = Date.now();
        if (!activeRef.current || now - lastSentRef.current >= TYPING_THROTTLE_MS) {
            activeRef.current = true;
            lastSentRef.current = now;
            socketRef.current?.sendTyping(channelId, true);
        }
        if (inactivityRef.current) clearTimeout(inactivityRef.current);
        inactivityRef.current = setTimeout(stop, TYPING_INACTIVITY_MS);
    }, [socketRef, channelId, stop]);

    // Смена канала / размонтирование — гасим на старом канале.
    useEffect(() => () => stop(), [channelId, stop]);

    return { onInput, stop };
}
```

### 5.5 `MessageInput.tsx` — подключение отправителя

Добавить два prop-а (прокидываются из `ChatPage`, где известен `selectedChannelId`), чтобы
компонент не тянул `socketRef` напрямую:

```ts
onTypingInput: (value: string) => void; // из useTypingEmitter().onInput
onTypingStop: () => void;               // из useTypingEmitter().stop
```

Вызовы:
- В `onChange` поля ввода (`MessageInput.tsx:469`):
  `onChange={(e) => { setText(e.target.value); onTypingInput(e.target.value); }}`
- В `handleSubmit` (`MessageInput.tsx:297`) сразу после успешной отправки (после `setText("")`,
  строка 352): `onTypingStop();`
- На `onBlur` поля ввода: `onBlur={() => onTypingStop()}` (гашение при потере фокуса, решение 3).

### 5.6 Хук получателя: `useTypingIndicator` (новый, `frontend/src/hooks/useTypingIndicator.ts`)

Хранит «кто печатает в каком канале» + per-(channel,user) TTL-таймер (решение 4, receiver TTL).

```ts
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import { TYPING_RECEIVER_TTL_MS } from "../services/typing.ts";

// channelId -> Set<userId>
export type TypingByChannel = Record<number, number[]>;

export function useTypingIndicator(
    socketRef: React.MutableRefObject<ChatSocket | null>,
    isConnected: boolean,
    currentUserId: number | null,
) {
    const [typingByChannel, setTypingByChannel] = useState<TypingByChannel>({});
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    useEffect(() => {
        if (!isConnected || !socketRef.current) return;
        const socket = socketRef.current;

        const clearUser = (channelId: number, userId: number) => {
            setTypingByChannel((prev) => {
                const list = prev[channelId];
                if (!list || !list.includes(userId)) return prev;
                const next = list.filter((id) => id !== userId);
                const copy = { ...prev };
                if (next.length) copy[channelId] = next; else delete copy[channelId];
                return copy;
            });
        };

        const unsub = socket.onTyping((event, isTyping) => {
            if (event.user_id === currentUserId) return; // свой ввод игнорируем (страховка)
            const key = `${event.channel_id}:${event.user_id}`;
            const existing = timersRef.current.get(key);
            if (existing) { clearTimeout(existing); timersRef.current.delete(key); }

            if (!isTyping) { clearUser(event.channel_id, event.user_id); return; }

            setTypingByChannel((prev) => {
                const list = prev[event.channel_id] ?? [];
                if (list.includes(event.user_id)) return prev;
                return { ...prev, [event.channel_id]: [...list, event.user_id] };
            });
            const t = setTimeout(() => {
                clearUser(event.channel_id, event.user_id);
                timersRef.current.delete(key);
            }, TYPING_RECEIVER_TTL_MS);
            timersRef.current.set(key, t);
        });

        return () => {
            unsub();
            timersRef.current.forEach((t) => clearTimeout(t));
            timersRef.current.clear();
        };
    }, [isConnected, socketRef, currentUserId]);

    return typingByChannel;
}
```

### 5.7 Резолв имён (решение 7) и компонент `TypingIndicator`

Новый компонент `frontend/src/components/TypingIndicator.tsx`. На вход — список `userId`
печатающих в активном канале + функция резолва имени.

Источники имени (по приоритету, `nickname → first_name`):
1. `onlineUsers` (уже загружен в `ChatPage`, есть `user_id`, `nickname`, `first_name`).
2. Авторы сообщений активного канала (`author_nickname`/`author_first_name`).
3. Ленивый `socket.getUserInfo(userId)` (уже есть, `chatSocket.ts:768`) с локальным кэшем —
   на редкий промах; до ответа показываем нейтральное «печатает…».

Форматирование (решение 6):

```ts
function formatTyping(names: string[]): string {
    switch (names.length) {
        case 0: return "";
        case 1: return `${names[0]} печатает…`;
        case 2: return `${names[0]} и ${names[1]} печатают…`;
        case 3: return `${names[0]}, ${names[1]} и ещё 1 печатают…`;
        default: return "Несколько человек печатают…";
    }
}
```

Разметка: контейнер с **фиксированной высотой-плейсхолдером** (не размонтировать, а
скрывать содержимое), чтобы `MessageList` не «прыгал». Анимированные точки — CSS.

### 5.8 `ChatPage.tsx` — композиция

- Создать эмиттер: `const typing = useTypingEmitter(socketRef, servers.selectedChannelId);`
- Создать приёмник: `const typingByChannel = useTypingIndicator(socketRef, isConnected, currentUserId);`
- Список печатающих в активном канале: `const typingUserIds = typingByChannel[servers.selectedChannelId] ?? [];`
- Рендер `<TypingIndicator userIds={typingUserIds} onlineUsers={...} messages={activeMessages}
  socketRef={socketRef} />` **между** `MessageList` (строка 584) и `MessageInput` (строка 587).
  Только для text-каналов (там, где рендерится `MessageInput`; блок уже скрыт для voice через
  `shouldHideMessageInput`, `ChatPage.tsx:174`).
- Пробросить в `MessageInput` пропсы `onTypingInput={typing.onInput}` и `onTypingStop={typing.stop}`.

### 5.9 CSS

В `frontend/src/styles/chat.css` добавить `.typing-indicator` (фиксированная min-height,
приглушённый цвет, `…`/точки-анимация через `@keyframes`). Совместить со светлой/тёмной темой
по существующим переменным.

---

## 6. Крайние случаи и как обрабатываются

| Кейс | Обработка |
|------|-----------|
| Отправка сообщения | `MessageInput.handleSubmit` → `onTypingStop()` → `typing_stop` (мгновенное скрытие) |
| Очистка поля до пустого | `useTypingEmitter.onInput("")` → `stop()` |
| Потеря фокуса | `onBlur` → `onTypingStop()` |
| Смена канала | cleanup-эффект в `useTypingEmitter` (`useEffect(()=>()=>stop(), [channelId])`) шлёт `typing_stop` на старый канал |
| Обрыв связи печатающего | `unregisterClient` рассылает `typing_stop` (решение 2) |
| Потерян `typing_stop` у получателя | receiver TTL 6 c авто-скрывает (решение 4) |
| Пауза между словами | throttle 3 c + TTL 6 c: индикатор не мерцает (инвариант `TTL > throttle`) |
| Печатает пользователь, которого клиент «не знает» | `getUserInfo` ленивая догрузка; до ответа — «печатает…» |
| Собственные события | фильтр `user_id === currentUserId` в `useTypingIndicator`; на сервере отправитель исключён из получателей |
| Voice-канал | typing не рендерится (там нет `MessageInput`); `typing_start` не шлётся |
| Переполнение `Outbound` | событие тихо дропается (`enqueueEvent` default-ветка) — допустимо |
| Несколько вкладок одного юзера | `clientsByUser` держит один клиент на юзера (старый закрывается при `registerClient`, `hub.go:123`) — конфликтов состояния нет |

---

## 7. Порядок реализации

1. **Backend протокол**: константы + типы в `types/websocket.go`.
2. **Backend хаб**: поле `typingChannelByUser`, инициализация в `NewHub`, `handleTyping`, ветки в
   `handleCommand`, гашение в `unregisterClient`.
3. `go build ./...` + `go vet ./...`.
4. **Frontend транспорт**: `TypingEvent` в `chat.ts`; `sendTyping` + `onTyping` + разбор события в
   `chatSocket.ts`; константы в `services/typing.ts`.
5. **Frontend хуки**: `useTypingEmitter`, `useTypingIndicator`.
6. **Frontend UI**: `TypingIndicator.tsx`, пропсы/вызовы в `MessageInput.tsx`, композиция в
   `ChatPage.tsx`, CSS.
7. `npm run build` (или `tsc --noEmit`) во `frontend/`.
8. Ручная проверка (см. §8).

---

## 8. Тестирование

**Ручное (2 браузера / 2 пользователя, один text-канал):**
1. A начинает печатать → у B появляется «A печатает…» ≤ ~0.5 c.
2. A перестаёт печатать, ничего не отправив → у B индикатор исчезает через ~5 c (inactivity),
   либо мгновенно при очистке поля.
3. A отправляет сообщение → индикатор у B исчезает сразу, приходит сообщение.
4. A печатает и резко закрывает вкладку → у B индикатор исчезает (серверный `typing_stop` по
   дисконнекту), в пределах receiver TTL — как страховка.
5. A и B печатают одновременно, наблюдает C → «A и B печатают…».
6. ≥4 печатающих → «Несколько человек печатают…».
7. A печатает 20 c подряд → на проводе видно `typing_start` примерно раз в 3 c (throttle),
   индикатор у B не мерцает.
8. Приватность: пользователь без доступа к каналу событие **не** получает (проверка
   `CanUserAccessChannel`).
9. Voice-канал: индикатор не показывается, `typing_start` не уходит.
10. Проверить отсутствие layout shift в `MessageList` при появлении/исчезновении индикатора.

**Проверки в DevTools:** во вкладке WS видно фреймы `typing_start`/`typing_stop`; частота
`typing_start` ≈ 1 / 3 c; на команды typing сервер не шлёт `ack`/`error`.

---

## 9. Список затрагиваемых файлов

**Backend**
- `types/websocket.go` — константы `typing_*`, типы `WsTypingRequest` / `WsTypingEvent`.
- `internal/service/server/hub.go` — поле состояния, `NewHub`, `handleCommand`, `handleTyping`,
  `unregisterClient`.

**Frontend**
- `frontend/src/types/chat.ts` — `TypingEvent`.
- `frontend/src/services/chatSocket.ts` — `sendTyping`, `onTyping`, разбор события.
- `frontend/src/services/typing.ts` — константы таймингов (новый).
- `frontend/src/hooks/useTypingEmitter.ts` — throttle + inactivity (новый).
- `frontend/src/hooks/useTypingIndicator.ts` — приём + receiver TTL (новый).
- `frontend/src/components/TypingIndicator.tsx` — UI + резолв имён (новый).
- `frontend/src/components/MessageInput.tsx` — пропсы `onTypingInput`/`onTypingStop`, вызовы.
- `frontend/src/pages/ChatPage.tsx` — композиция хуков, рендер индикатора, проброс пропсов.
- `frontend/src/styles/chat.css` — стили `.typing-indicator` + анимация.

---

## 10. Явно вне объёма (возможные доработки)

- Серверный полноценный TTL/GC печатающих (решение было — гибрид, не stateful).
- Индикатор набора для voice / DM (в проекте нет DM).
- Значок «печатает» в списке каналов/серверов (только в активном канале).
- Обогащение события именем на сервере (сознательно отклонено, решение 7).
