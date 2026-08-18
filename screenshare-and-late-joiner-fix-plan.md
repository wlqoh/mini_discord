# План: чёрный экран при демонстрации + новый участник не видит камеру

Документ самодостаточный: содержит диагноз с точными ссылками на код, принятые
решения с обоснованием, пошаговые изменения и способ проверки. Читать вместе с
`sfu-migration-plan.md` (нумерация decision #N ниже — оттуда), но для выполнения
работ достаточно этого файла.

Ветка на момент составления: `refactoring-webRTC-mesh-system-to-SFU-system`,
HEAD `43b252d`.

---

## 1. Симптомы

1. **При демонстрации экрана виден только чёрный экран.**
2. **Если камера включена и в канал заходит новый человек, он этой камеры не
   видит.**

---

## 2. Диагноз

Найдено пять независимых дефектов. Первые два дают ровно заявленные симптомы,
остальные три — того же семейства и всплывут сразу после починки первых двух.

### Дефект 1 — свой экран никогда не попадает в свой тайл

`frontend/src/services/sfuCallClient.ts` → `startScreenShare()`: трек экрана
уходит только в `sender.replaceTrack(displayTrack)` и сохраняется в приватном
`this.screenStream`. Ни `this.localStream`, ни колбэк `onLocalStream` при этом
не трогаются, а наружу поток экрана не отдаётся вообще (в `VoiceClient` есть
только `isScreenShareActive(): boolean`).

Свой тайл в `frontend/src/pages/ChatPage.tsx:871` рисуется из
`voice.localStream`. В `localStream` лежит камера, которую `join()` при входе
принудительно гасит:

```ts
// sfuCallClient.ts, join()
stream.getVideoTracks().forEach((track) => { track.enabled = false; });
```

Итог: демонстрирующий смотрит на чёрный прямоугольник своей выключенной камеры.
Для остальных участников экран при этом передаётся нормально.

### Дефект 2 — новому участнику не отдаётся снапшот уже опубликованных треков

Сервер рассылает `sfu_track_published` только в момент **первого** `OnTrack` по
источнику — `internal/service/sfu/peer.go`, `handleOnTrack()`:

```go
p.router.sig.SendTrackPublished(p.channelID, TrackInfo{...})
```

Новому пиру ничего подобного не отправляется:

* `autoSubscribeToExisting()` (`peer.go`) подписывает только **аудио**
  (`publishedAudioTracks()`), потому что по decision #8 видео требует явного
  `sfu_subscribe_video`;
* в ack на `join_voice_channel` (`types/websocket.go`,
  `WsJoinVoiceChannelResponse`) полей о треках нет вообще — только
  `participants`, `session_id`, `ice_servers`, `publish_slots`.

Клиент подписывается на видео исключительно из `handleTrackPublished()`
(`sfuCallClient.ts`). Значит про всё, что было опубликовано **до** его входа, он
не узнаёт никогда. Это и есть «новый человек не видит камеру», и это же делает
чёрным экран для того, кто зашёл в уже идущую демонстрацию.

### Дефект 3 — подписчик не-simulcast трека стартует с середины GOP

`internal/service/sfu/track.go`, `forwardToSubscribers()`:

```go
switch {
case sub.activeRID == layer.rid:
    // уже на этом слое
case sub.pendingRID == layer.rid && isKeyframe:
    sub.rewrite.start(packet.SequenceNumber, packet.Timestamp)
    sub.activeRID = layer.rid
    sub.pendingRID = ""
default:
    ...
}
```

Для не-simulcast источника (экран, `screen_audio`, микрофон) RID слоя — пустая
строка. У свежесозданного подписчика `activeRID` — тоже пустая строка
(нулевое значение). Первая ветка совпадает мгновенно, поэтому:

* `rewrite.start()` не вызывается никогда → `rtpRewriter.initialized` остаётся
  `false`;
* пакеты льются подписчику сразу, с произвольного места GOP — до прихода
  keyframe декодер отдаёт чёрный кадр или артефакты.

Камера этим не задета: она simulcast (`CAMERA_SIMULCAST_ENCODINGS` с RID
`l`/`m`/`h`), поэтому `"" != "l"` и работает корректная ветка. Ровно поэтому
симптом наблюдается именно на демонстрации экрана.

### Дефект 4 — при возобновлении публикации никто не запрашивает keyframe

PLI с ретраями (`requestKeyframeForRIDWithRetry`, `track.go`) отправляется только
при **создании** подписки (`doSubscribe`). Остановка демонстрации — это
`sender.replaceTrack(null)`, m-line и подписки при этом сохраняются
(decision #3, без renegotiation). При повторном старте новых подписок нет →
PLI никто не шлёт → уже подписанные зрители ждут очередной keyframe от браузера.
При `degradationPreference: "maintain-resolution"` и статичном содержимом экрана
это может быть несколько секунд.

`handleSfuPublishState` (`internal/service/server/hub.go`) сегодня — чистый
ретранслятор («purely informational — never touches the router or the media
path»), поэтому подсказать SFU, что источник ожил, некому.

### Дефект 5 — остановка шаринга кнопкой браузера не доходит до комнаты

`sfuCallClient.ts`:

```ts
isScreenShareActive(): boolean {
  return Boolean(this.screenStream && this.screenStream.getVideoTracks()[0]?.readyState !== "ended");
}

async stopScreenShare(): Promise<void> {
  if (!this.isScreenShareActive()) { return; }   // <-- ранний выход
  ...
  this.announcePublishState("screen", false);
}
```

Когда пользователь жмёт браузерную плашку «Stop sharing», трек переходит в
`readyState === "ended"`, срабатывает `displayTrack.onended → stopScreenShare()`,
но `isScreenShareActive()` уже вернёт `false` — и метод выходит на первой
строке. В результате: `announcePublishState("screen", false)` не отправляется,
`this.screenStream` не обнуляется, `sender.replaceTrack(null)` не вызывается.
У зрителей тайл остаётся на последнем кадре демонстрации.

---

## 3. Принятые решения

Зафиксированы в интервью, менять их в ходе реализации без явного согласования не
нужно.

| # | Решение | Выбор | Почему |
|---|---|---|---|
| 1 | Границы починки | Оба бага целиком, включая сопутствующие дефекты 3–5 | Симптомы вызваны разными причинами; починка одной не лечит вторую |
| 2 | Локальное превью экрана | Отдельный `localScreenStream` + новый колбэк; свой тайл показывает экран, если он есть, иначе камеру | Зеркалит уже принятую логику для удалённых (`reconcileRemoteVideo`: screen приоритетнее camera в одном тайле) и не ломает `setCameraEnabled`/`switchCameraFacingMode`, которые полагаются на то, что в `localStream` ровно один видеотрек — камера |
| 3 | Доставка снапшота | Персональные `sfu_track_published` новому пиру, отправляются в `handleOffer` рядом с `autoSubscribeToExisting` | Переиспользует уже рабочий путь клиента (`handleTrackPublished` → дебаунс → `sfu_subscribe_video`), не меняет контракт `join`, оставляет simulcast-политику качества на клиенте. **Именно `handleOffer`, а не `Join`**: клиент выставляет `currentChannelID` только после ack (`applySession`), а `handleTrackPublished` отбрасывает события с чужим `channel_id` — снапшот, отправленный раньше, был бы молча потерян |
| 4 | Состояние «включено сейчас» | Хранить `active` по каждому source в `sfu.Peer`; `sfu_publish_state` роутится через `Router`; клиент анонсирует и камеру тоже | Снапшот становится честным описанием состояния комнаты: новичок не подписывается на выключенную камеру и не перекрывает живую камеру приостановленной демонстрацией |
| 5 | Первый кадр при возобновлении | PLI с ретраями по всем слоям на `publish_state active=true` | Механизм ретраев уже написан и отлажен; при решении #4 состояние и так проходит через роутер |
| 6 | Пустой RID | Явный флаг `hasActive bool` в `trackSubscriber` | Устраняет коллизию «слой не выбран» vs «RID пустой» навсегда; ветка `pendingRID + isKeyframe` уже протестирована для simulcast |
| 7 | Верификация | Go-юнит-тесты + ручной прогон в браузере | В `internal/service/sfu/simulcast_test.go` уже есть заготовки; e2e в `cmd/sfuload` — отдельная задача |
| 8 | Формат сдачи | Только этот план; код по нему пишется отдельно | Решение заказчика |

**Явно вне объёма:** авто-подписка на видео на сервере (ломает decision #8 и
экономию трафика), e2e-сценарий в `cmd/sfuload`, отдельный тайл «Ваш экран»,
изменение контракта `join_voice_channel`.

---

## 4. Реализация

Пять этапов, каждый компилируется и осмысленно отдельно. Порядок важен: этап 2
(сервер) должен уйти раньше этапа 4 (клиент анонсирует камеру), иначе сервер
ответит `invalid_source`.

### Этап 1. Фронтенд: своё превью экрана + починка остановки шаринга

Закрывает дефекты 1 и 5. Backend не трогается.

**`frontend/src/services/voiceClient.ts`**

Добавить рядом с `LocalStreamListener`:

```ts
export type LocalScreenStreamListener = (stream: MediaStream | null) => void;
```

Интерфейс `VoiceClient` не меняется — колбэк передаётся через конструктор
`SfuCallClient`, как и остальные.

**`frontend/src/services/sfuCallClient.ts`**

1. Новое поле и параметр конструктора `onLocalScreenStream:
   LocalScreenStreamListener`, ставится сразу после `onLocalStream` (порядок
   параметров важен — см. вызов в `useServers.ts`).
2. `startScreenShare()`: после `this.screenStream = displayStream;` вызвать
   `this.onLocalScreenStream(displayStream);`
3. `stopScreenShare()`: заменить ранний выход на проверку самого поля, иначе
   остановка кнопкой браузера не отработает (дефект 5):

```ts
async stopScreenShare(): Promise<void> {
  const activeScreenStream = this.screenStream;
  if (!activeScreenStream) {
    return;
  }
  this.screenStream = null;

  // Трек может быть уже "ended" — это как раз путь через браузерную плашку
  // "Stop sharing": displayTrack.onended вызывает нас сам. stop() на уже
  // остановленном треке безопасен и идемпотентен.
  activeScreenStream.getVideoTracks().forEach((track) => track.stop());

  const sender = this.senderBySource.get("screen");
  if (sender) {
    await sender.replaceTrack(null);
  }
  this.onLocalScreenStream(null);
  this.announcePublishState("screen", false);
}
```

4. `leave()` / `teardownPeerConnection()`: там, где `this.screenStream = null`,
   добавить `this.onLocalScreenStream(null)` — иначе после выхода из канала своё
   превью залипнет.

**`frontend/src/hooks/useVoice.ts`**

```ts
const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);

const onLocalScreenStream = useCallback((stream: MediaStream | null) => {
    setLocalScreenStream(stream);
    setIsScreenSharing(Boolean(stream));
}, []);
```

* добавить `onLocalScreenStream` в `callClientCallbacks` (`useMemo` около строки
  176) и в его массив зависимостей;
* в `onLocalStream`, в ветке `if (!stream)` (выход из канала), добавить
  `setLocalScreenStream(null)`;
* вернуть `localScreenStream` из хука рядом с `localStream`.

Существующая строка `setIsScreenSharing(callClientRef.current?.isScreenShareActive() ?? false)`
в `onLocalStream` остаётся — она не мешает, но источником истины теперь является
`onLocalScreenStream`.

**`frontend/src/hooks/useServers.ts`**

В типе `callClientCallbacks` (около строки 33) и в вызове
`new SfuCallClient(...)` (строка 185) добавить
`callClientCallbacks.onLocalScreenStream` сразу после `onLocalStream`.

**`frontend/src/pages/ChatPage.tsx`**

Свой тайл (строка ~871):

```tsx
{(voice.localScreenStream || voice.localStream) && (
    <VideoTile
        stream={voice.localScreenStream ?? voice.localStream}
        label={voice.localScreenStream ? "You (screen)" : "You"}
        muted
        micEnabled={voice.isMicEnabled}
        deafened={voice.isDeafened}
    />
)}
```

Тайл остаётся `muted`, так что подмена потока не влияет на звук.

### Этап 2. Сервер: состояние публикации и снапшот треков

Закрывает дефекты 2 и 4.

**`internal/service/sfu/sfu.go`**

Расширить `Signaler` одним методом — доставка события конкретному
пользователю, а не всей комнате:

```go
// SendTrackPublishedTo доставляет track_published одному пользователю —
// снапшот уже опубликованных треков новому участнику. channelID нужен,
// потому что клиент фильтрует события по нему (см. handleTrackPublished).
SendTrackPublishedTo(userID int, channelID int64, t TrackInfo)
```

**`internal/service/sfu/peer.go`**

1. Новое поле в `Peer`, под уже существующим `publishedMu` (тот же мьютекс, та
   же причина: читается из горутины другого пира):

```go
// publishState — явно заявленное паблишером состояние источника
// (sfu_publish_state). Отсутствие записи означает "активен": камера
// физически публикуется всегда (decision #3, выключение — это
// track.enabled=false, а не остановка трека), поэтому дефолт true
// сохраняет прежнее поведение для клиентов, которые ещё не анонсируют
// состояние камеры.
publishState map[Source]bool
```

Инициализировать в `newPeer`.

2. Методы:

```go
func (p *Peer) setPublishState(source Source, active bool) {
    p.publishedMu.Lock()
    p.publishState[source] = active
    pub := p.published[source]
    p.publishedMu.Unlock()

    // Источник ожил: уже подписанные зрители не получат новую подписку и,
    // значит, ни одного PLI — без этого они ждут очередной keyframe от
    // браузера паблишера (дефект 4).
    if active && pub != nil {
        for _, rid := range pub.layerRIDs() {
            pub.requestKeyframeForRIDWithRetry(rid)
        }
    }
}

func (p *Peer) isSourceActive(source Source) bool {
    p.publishedMu.RLock()
    defer p.publishedMu.RUnlock()
    active, ok := p.publishState[source]
    return !ok || active
}

// publishedVideoTrackInfos — активные видеоисточники этого пира, для
// снапшота новому участнику. Аудио сюда не входит: оно автоподписывается
// сервером (decision #8), клиенту знать о нём незачем.
func (p *Peer) publishedVideoTrackInfos() []TrackInfo {
    p.publishedMu.RLock()
    defer p.publishedMu.RUnlock()
    var out []TrackInfo
    for source, pub := range p.published {
        if pub.kind != webrtc.RTPCodecTypeVideo {
            continue
        }
        if active, ok := p.publishState[source]; ok && !active {
            continue
        }
        out = append(out, TrackInfo{UserID: p.userID, Source: source, Kind: kindString(pub.kind)})
    }
    return out
}
```

3. В `handleOffer()`, сразу после `p.autoSubscribeToExisting()`:

```go
p.sendTrackSnapshot()
```

```go
// sendTrackSnapshot сообщает только что подключившемуся пиру о видеотреках,
// опубликованных в комнате ДО его прихода. Без этого он узнавал бы о чужом
// видео только из broadcast'а в момент первой публикации и навсегда пропускал
// всё, что началось раньше. Отправляется отсюда, а не из Router.Join: клиент
// выставляет currentChannelID только после ack на join_voice_channel и
// отбрасывает события с чужим channel_id — к моменту прихода offer'а сессия у
// него уже применена.
func (p *Peer) sendTrackSnapshot() {
    for _, other := range p.room.others(p.userID) {
        for _, info := range other.publishedVideoTrackInfos() {
            p.router.sig.SendTrackPublishedTo(p.userID, p.channelID, info)
        }
    }
}
```

**`internal/service/sfu/router.go`**

```go
// SetPublishState фиксирует явно заявленное паблишером состояние источника
// (sfu_publish_state) и, если источник ожил, запрашивает keyframe для уже
// существующих подписчиков. Состояние живёт на Peer, а не на publishedTrack:
// publish_state может прийти раньше первого OnTrack по этому слоту.
func (r *Router) SetPublishState(sessionID string, source Source, active bool) error {
    peer, ok := r.peerBySession(sessionID)
    if !ok {
        return fmt.Errorf("sfu: unknown session %s", sessionID)
    }
    peer.setPublishState(source, active)
    return nil
}
```

Через очередь команд пира это гнать не нужно: метод работает под узким
`publishedMu`, как и остальные кросс-горутинные чтения `published` (см.
комментарий к типу `Peer`).

**`internal/service/server/hub.go`**

1. Реализовать новый метод сигнализации рядом с `SendTrackPublished`:

```go
func (h *Hub) SendTrackPublishedTo(userID int, channelID int64, t sfu.TrackInfo) {
    h.pushToUsers([]int{userID}, &types.WsEvent{
        Event: types.WsEventSfuTrackPublished,
        Data:  types.WsSfuTrackEvent{ChannelID: channelID, UserID: t.UserID, Source: string(t.Source), Kind: t.Kind},
    })
}
```

(Точное имя хелпера доставки одному пользователю — по образцу соседних методов;
в файле уже используются `pushToUsers` и `pushEvent`.)

2. `handleSfuPublishState`: снять ограничение «только screen» и прокинуть
   состояние в роутер до броадкаста:

```go
source := sfu.Source(payload.Source)
if source != sfu.SourceScreen && source != sfu.SourceCamera {
    h.pushSfuError(req.client, payload.SessionID, "invalid_source", "publish state is only supported for screen and camera")
    return
}

if h.sfuRouter != nil {
    if err := h.sfuRouter.SetPublishState(payload.SessionID, source, payload.Active); err != nil {
        h.log.Debug("sfu: set publish state failed", "err", err)
    }
}

info := sfu.TrackInfo{UserID: req.client.UserID, Source: source, Kind: "video"}
if payload.Active {
    h.SendTrackPublished(channelID, info)
} else {
    h.SendTrackUnpublished(channelID, info)
}
```

Комментарий над `WsActionSfuPublishState` в `types/websocket.go` («currently only
"screen"», «never touches the router or the media path») теперь неверен — его
надо обновить: источников два, и обработчик влияет на медиапуть через PLI.

### Этап 3. Сервер: `hasActive` в `trackSubscriber`

Закрывает дефект 3. Файл — `internal/service/sfu/track.go`.

1. Поле в `trackSubscriber`:

```go
// hasActive отделяет "слой ещё не выбран" от "выбран слой с пустым RID".
// Без него не-simulcast трек (экран, mic, screen_audio — RID "") совпадал
// с нулевым значением activeRID и подписчик начинал получать пакеты с
// середины GOP, минуя rewrite.start().
hasActive bool
```

2. `forwardToSubscribers`:

```go
switch {
case sub.hasActive && sub.activeRID == layer.rid:
    // уже на этом слое
case sub.pendingRID == layer.rid && isKeyframe:
    sub.rewrite.start(packet.SequenceNumber, packet.Timestamp)
    sub.hasActive = true
    sub.activeRID = layer.rid
    sub.pendingRID = ""
default:
    sub.mu.Unlock()
    continue
}
```

3. `setSubscriberQuality`: `if sub.activeRID != targetRID` → `if !sub.hasActive || sub.activeRID != targetRID`.

4. `setDegraded`:
   `changed = sub.pendingRID != targetRID && (!sub.hasActive || sub.activeRID != targetRID)`.

5. `subscriberLayerState`: возвращать `"", sub.pendingRID`, если `!sub.hasActive`
   — иначе debug-снапшот покажет несуществующий активный слой.

**Осознанный риск.** Теперь подписчик до первого keyframe не получает ничего
(раньше получал мусор, который декодер всё равно отбрасывал). Если все PLI
потеряются, картинки не будет до конца ретраев (`keyframeRetryMaxAttempts = 10`
× `keyframeRetryInterval = 1.5s` ≈ 15 с). Компенсации: PLI шлётся при создании
подписки и, после этапа 2, при `publish_state active=true`; аудио проходит
мгновенно (`isKeyframe := !isVideo`).

### Этап 4. Клиент: анонс состояния камеры

Требует уже задеплоенного этапа 2.

**`frontend/src/services/sfuCallClient.ts`**

1. `setCameraEnabled`:

```ts
setCameraEnabled(enabled: boolean): void {
  this.localStream?.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
  // Камера никогда не останавливается физически (decision #3), поэтому SFU
  // не может отличить выключенную камеру от чёрного кадра — говорим явно,
  // иначе новый участник подпишется на чёрный поток.
  this.announcePublishState("camera", enabled);
}
```

2. В `join()`, после `await this.openPeerConnection()`:
   `this.announcePublishState("camera", false);` — камера гасится при входе, и
   это должно быть видно в снапшоте для тех, кто зайдёт позже.

3. `handleTrackPublished`: расширить условие на камеру —

```ts
if (event.source === "screen" || event.source === "camera") {
  this.reappearRemoteVideo(event.user_id, event.source);
}
```

4. `handleTrackUnpublished`: аналогично —

```ts
if (event.source === "screen" || event.source === "camera") {
  this.hideRemoteVideo(event.user_id, event.source);
}
```

Типы `hideRemoteVideo`/`reappearRemoteVideo` уже принимают `"camera" | "screen"`,
менять сигнатуры не нужно — только сузить `event.source` до этого объединения.

### Этап 5. Тесты

**Go — `internal/service/sfu/` (образец фейков смотреть в `simulcast_test.go`)**

1. `TestSingleLayerSubscriberWaitsForKeyframe` — не-simulcast `publishedTrack`,
   один подписчик: подать пару не-keyframe VP8-пакетов → в локальный трек не
   ушло ничего; подать keyframe → пакеты пошли, и последующие тоже.
2. `TestPublishStateHidesSourceFromSnapshot` — `setPublishState(SourceCamera,
   false)` → `publishedVideoTrackInfos()` не содержит камеру; после
   `setPublishState(SourceCamera, true)` — содержит.
3. `TestSnapshotSentToJoiningPeer` — фейковый `Signaler` считает вызовы
   `SendTrackPublishedTo`: пир, вошедший в комнату с уже опубликованными
   камерой и экраном, получает ровно два события и ни одного по аудио.
4. `TestPublishStateActiveRequestsKeyframe` — `setPublishState(source, true)`
   при существующем `publishedTrack` приводит к записи PLI в фейковый PC.

**Команды**

```bash
go build ./... && go vet ./... && go test ./internal/service/sfu/...
cd frontend && npm run build && npx eslint src
```

---

## 5. Ручная проверка

Три вкладки/профиля браузера (A, B, C), один голосовой канал. При включённом
`localStorage.setItem("webrtc_debug", "1")` в консоль пишутся события SFU.
Серверное состояние — `GET /api/v1/admin/sfu/rooms`.

| # | Сценарий | Ожидание | Какой дефект проверяет |
|---|---|---|---|
| 1 | A и B в канале, A включает камеру | B видит камеру A | регресс-контроль |
| 2 | При включённой камере A входит C | **C видит камеру A** | 2 |
| 3 | A запускает демонстрацию | **A видит свой экран в своём тайле** (подпись «You (screen)»), B видит экран A | 1 |
| 4 | Во время демонстрации входит C | C видит экран A, а не камеру и не чёрное | 2 + 3 |
| 5 | A останавливает демонстрацию **кнопкой браузера** «Stop sharing» | У B и C тайл A мгновенно возвращается к камере; у A кнопка переходит в «Share screen» | 5 |
| 6 | A останавливает и заново запускает демонстрацию | Картинка у B появляется за 1–2 с, без «застывшего кадра» | 4 |
| 7 | A выключает камеру, затем входит D | D **не подписан** на `camera` пользователя A (проверить в `/api/v1/admin/sfu/rooms`), тайл A без видео | 4 (решение #4) |
| 8 | A выключает и включает камеру при уже подписанном B | Картинка у B возвращается за 1–2 с | 4 |

---

## 6. Риски и на что смотреть при ревью

1. **Порядок деплоя.** Этап 4 (клиент шлёт `publish_state` для камеры) обязан
   выехать не раньше этапа 2 (сервер принимает `camera`), иначе клиент получит
   `invalid_source` на каждое переключение камеры. В монолите это один деплой —
   но при частичном откате порядок надо соблюсти.
2. **Дефолт активности = `true`.** Выбран сознательно: при отсутствии записи в
   `publishState` источник считается включённым, поэтому клиент, который не
   анонсирует камеру, ведёт себя ровно как сегодня. Инвертировать дефолт
   нельзя — это скроет камеры у всех, кто не успел прислать `publish_state`.
3. **Снапшот и `MaxRoomParticipants`.** `sendTrackSnapshot` — O(участники ×
   источники) вызовов сигнализации на один вход. При комнате из 20 человек с
   камерой и экраном это 40 сообщений, которые клиент склеит своим дебаунсом
   (`SUBSCRIBE_DEBOUNCE_MS = 300`) в один пакет `sfu_subscribe_video`. Приемлемо,
   но если лимит комнаты будут поднимать — переходить на решение A из вопроса 3
   (одно событие со списком).
4. **`hasActive` в горячем пути.** Изменение затрагивает `forwardToSubscribers`,
   который исполняется на каждый RTP-пакет. Правка чисто логическая, без новых
   аллокаций и блокировок, но именно её надо смотреть внимательнее всего —
   ошибка здесь ломает видео всей комнаты, а не одного тайла.
5. **Устаревшие комментарии.** После этапа 2 неверны: доккомментарий
   `WsActionSfuPublishState` в `types/websocket.go` («only "screen"», «never
   touches the router or the media path») и доккомментарий
   `handleSfuPublishState` в `hub.go`. Обновить вместе с кодом — в этом проекте
   комментарии несут проектные решения, расхождение дорого стоит.

---

## 7. Чеклист

- [ ] Этап 1: `voiceClient.ts`, `sfuCallClient.ts` (превью + починка
      `stopScreenShare`), `useVoice.ts`, `useServers.ts`, `ChatPage.tsx`
- [ ] Этап 2: `sfu.go` (`Signaler`), `peer.go` (`publishState`,
      `sendTrackSnapshot`), `router.go` (`SetPublishState`), `hub.go`
      (`SendTrackPublishedTo`, `handleSfuPublishState`)
- [ ] Этап 3: `track.go` (`hasActive` в 5 местах)
- [ ] Этап 4: `sfuCallClient.ts` (`setCameraEnabled`, `join`,
      `handleTrackPublished`, `handleTrackUnpublished`)
- [ ] Этап 5: четыре Go-теста, `go test ./internal/service/sfu/...` зелёный
- [ ] `go build ./... && go vet ./...` зелёные
- [ ] `npm run build` и `eslint` зелёные
- [ ] Ручные сценарии 1–8 пройдены
- [ ] Устаревшие комментарии обновлены (см. риск 5)
