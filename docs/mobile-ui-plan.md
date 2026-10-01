# План: полная оптимизация веб-UI под телефоны

> Ветка: `phone-web-ui-optimization` → один PR в `main`.
> Область: только `frontend/`. Backend не меняется.
> Документ самодостаточен: в нём описаны контекст, принятые решения, шаги по файлам, критерии приёмки и чек-лист проверки.

---

## 1. Контекст и проблемы

Стек: React 19 + Vite 7 + TypeScript, без UI-библиотек, иконки `lucide-react`. Весь чат — один экран `frontend/src/pages/ChatPage.tsx` (~1.5k строк), стили в `frontend/src/styles/chat.css` (~4.2k строк), а также `index.css`, `mediaPlayer.css` и `videoPlayer.css`.

Жалобы пользователя: «всё криво-косо», «правый край сужается», «много кнопок не кликабельны».

Найденные причины:

| Симптом | Причина в коде |
|---|---|
| Правый край сужается / уезжает | `.chat-layout` использует `grid-template-columns: … 1fr`, а `1fr` = `minmax(auto, 1fr)`. Длинные слова, ссылки, `pre`, превью ссылок и видео распирают колонку шире viewport. Плюс на телефоне всегда виден rail серверов 52–60 px. |
| Кнопки не кликабельны | Разрозненные оверлеи с собственными z-index (199, 200, 220, 9999…) и `pointer-events`. Drawer каналов перекрывает контент. Действия над сообщением рассчитаны на hover. `onContextMenu` (сообщения, серверы, каналы, DM) не работает в iOS Safari. Popover-ы (`ContextMenu`, `.voice-volume-popover`, `.online-users-panel`) позиционируются координатами и вылезают за экран. |
| «Криво» в целом | Мобильные правила разбросаны по 5 блокам `@media (max-width: 768px)` в `chat.css` и перебивают друг друга. Брейкпоинты в CSS (1024/900/768/480) и в JS (`isMobileDevice = (max-width:1024px) and (pointer:coarse)`, `isPhone = (max-width:768px)`) не согласованы. Клавиатура iOS ломает высоту layout. Композер на мобильном переносится в 2 строки. |
| Лаги | `backdrop-filter: blur(20px)` на постоянно видимых панелях, `background-attachment: fixed`, фоновые анимации. |

---

## 2. Принятые решения (итог интервью)

| # | Тема | Решение |
|---|---|---|
| 1 | Навигация | **Как в мобильном Discord:** rail серверов и список каналов объединены в один drawer, чат по умолчанию на 100% ширины. |
| 2 | Брейкпоинт | Единый мобильный режим: `(max-width: 768px), (max-height: 500px) and (pointer: coarse)`. Тач-специфика — через `@media (hover: none)`. |
| 3 | Жесты drawer | Кнопка ☰ + свайп (свой хук `useSwipe`, с порогами и исключениями). |
| 4 | Действия над сообщением | Долгое нажатие (~450 мс) открывает bottom sheet с действиями. Inline-кнопки «ответить/удалить» на тач-экране скрыты. |
| 5 | Модалки и popover-ы | Единый компонент `<Sheet>`: модалка/popover на десктопе, bottom sheet на мобильном. Единая шкала z-index. |
| 6 | Клавиатура и композер | Хук `useVisualViewport` → `--app-height`/`--keyboard-inset`, фиксированный body, однострочный композер. |
| 7 | Звонок | Мини-бар над композером + разворачиваемый полноэкранный экран звонка. |
| 8 | Кнопка «назад» | Хук `useBackDismiss`: стек оверлеев через History API, «назад» закрывает верхний оверлей. |
| 9 | CSS | Всё мобильное собрано в `styles/mobile.css` (импортируется последним), добавлены токены. Десктоп не трогаем. |
| 10 | Шапка | Однострочная: ☰ · «# канал / сервер» · 🔍 · ⋮. Меню ⋮ — Sheet с вторичными действиями. |
| 11 | Эффекты | На мобильном blur отключён у постоянно видимых панелей, остаётся только у Sheet/оверлеев. Фоновые анимации выключены. |
| 12 | Проверка | Ручной чек-лист (DevTools + реальные iPhone и Android) + dev-оверлей диагностики. Playwright — отдельная задача потом. |
| 13 | Поставка | Один PR. Внутри — осмысленные коммиты по этапам из раздела 4. |

**Вне рамок задачи:** URL-роутинг каналов (`/servers/:id/channels/:id`), Playwright/e2e в CI, разбиение `chat.css` на компонентные файлы, нижний tab bar, свайп сообщения для ответа, интерактивный drag drawer за пальцем.

---

## 3. Общие соглашения

### 3.1. Мобильный медиа-запрос

Одна строка, используется везде:

```
(max-width: 768px), (max-height: 500px) and (pointer: coarse)
```

- **JS:** новый файл `frontend/src/hooks/useIsMobile.ts`:
  ```ts
  export const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px) and (pointer: coarse)";
  export function useIsMobile() { return useMediaQuery(MOBILE_QUERY); }
  ```
  Также `useIsTouch()` = `useMediaQuery("(hover: none)")`.
- **CSS:** в `mobile.css` всё лежит внутри `@media (max-width: 768px), (max-height: 500px) and (pointer: coarse) { … }`. Строку не редактируем «на глаз»: если её меняем, то синхронно в обоих местах (оставить комментарий-ссылку на `useIsMobile.ts`).
- В `ChatPage.tsx` заменить `isPhone` на `useIsMobile()`. `isMobileDevice` (показ кнопки «сменить камеру» вместо screen share) заменить на `useIsMobile() && useIsTouch()`.
- Существующий блок `@media (max-width: 1024px)` (планшет, сетка 64/220) оставить в `chat.css` как есть.

### 3.2. Токены (в `:root`, `index.css`)

```css
--tap-min: 44px;
--app-height: 100dvh;            /* перезаписывается useVisualViewport */
--keyboard-inset: 0px;           /* перезаписывается useVisualViewport */
--safe-top: env(safe-area-inset-top);
--safe-bottom: env(safe-area-inset-bottom);
--safe-left: env(safe-area-inset-left);
--safe-right: env(safe-area-inset-right);
--header-h: 48px;

/* Единая шкала слоёв — ВСЕ z-index в проекте переводим на неё */
--z-base: 0;
--z-sticky: 10;      /* jump-to-latest, typing indicator */
--z-callbar: 50;     /* мини-бар звонка */
--z-drawer-overlay: 100;
--z-drawer: 110;
--z-screen: 200;     /* полноэкранный поиск, полноэкранный звонок */
--z-sheet-overlay: 300;
--z-sheet: 310;
--z-toast: 400;
--z-devtools: 9999;
```

Пройтись `grep -n "z-index" src/**/*.css` и заменить все литералы на токены.

### 3.3. Структура новых файлов

```
frontend/src/
  hooks/
    useIsMobile.ts          — MOBILE_QUERY, useIsMobile, useIsTouch
    useVisualViewport.ts    — --app-height / --keyboard-inset
    useSwipe.ts             — горизонтальный свайп с порогами
    useLongPress.ts         — долгое нажатие с отменой при скролле
    useBackDismiss.ts       — стек оверлеев через History API
    useBodyScrollLock.ts    — блокировка скролла под Sheet (если нужно отдельно)
  components/
    Sheet.tsx               — модалка/popover ↔ bottom sheet
    MobileDrawer.tsx        — обёртка drawer (серверы + каналы), если удобнее выделить
    VoiceMiniBar.tsx        — мини-бар звонка
    CallScreen.tsx          — полноэкранный звонок
    dev/LayoutDebugOverlay.tsx — dev-диагностика
  styles/
    mobile.css              — ВСЕ мобильные правила (импорт последним)
    sheet.css
    call.css                — мини-бар + полноэкранный звонок
```

`mobile.css`, `sheet.css` и `call.css` импортируются в `main.tsx` (или там же, где сейчас `chat.css`), `mobile.css` — последним.

Правило проекта из `docs/frontend.md`: **логику выносить в хуки, не раздувать `ChatPage.tsx`.** Новые экраны и обёртки — отдельные компоненты.

---

## 4. Этапы работ (коммиты внутри одного PR)

Каждый этап оставляет приложение в рабочем состоянии и на десктопе, и на телефоне.

### Этап 1. Фундамент и устранение сужения

1. **Fix overflow сетки** (`chat.css`, десктоп тоже выигрывает):
   - Во всех `grid-template-columns` у `.chat-layout` заменить `1fr` на `minmax(0, 1fr)`.
   - Главной колонке чата и её flex-потомкам (`.chat-main`, `.chat-content`, лента, `.message-item`, `.message-row`) задать `min-width: 0`.
   - Тексту сообщений: `overflow-wrap: anywhere; word-break: break-word;`.
   - `pre`/код: `max-width: 100%; overflow-x: auto;`.
   - Изображения, видео, `.link-preview`, плееры (`mediaPlayer.css`, `videoPlayer.css` с `max-width: 360/480px`): `max-width: 100%`.
   - `html, body { overflow-x: hidden; }` — только как страховка, а не как основное лечение.
2. **Создать `useIsMobile.ts`** и заменить им `isPhone` / `isMobileDevice` в `ChatPage.tsx` (см. 3.1).
3. **Добавить токены** (3.2) и перевести все z-index на шкалу.
4. **Создать `styles/mobile.css`.** Перенести туда все блоки `@media (max-width: 768px)` и `@media (max-width: 480px)` из `chat.css` (строки ~2586–2905, ~3328, ~3595, ~4225), а также `@media (max-width: 900px) and (orientation: landscape)`. Объединить их под единым мобильным запросом, сохранив вложенный `@media (max-width: 480px)` для мелких правок. Блоки 768/480 из `index.css` (страницы логина и регистрации) — туда же. Устранить дубли и противоречия.
5. **Тап-зоны:** в `mobile.css` всем интерактивным элементам (`button`, `[role=button]`, элементы списков каналов, серверов и DM) задать `min-height: var(--tap-min)`, а маленьким иконкам — `min-width: var(--tap-min)` (расширять хит-зону через padding, визуальный размер иконки не менять). Удалить точечные правила по 44 px — их заменяет общее.
6. **iOS-зум:** у всех `input`, `textarea`, `select` на мобильном `font-size: 16px` (композер сейчас — `<input class="message-input">`).
7. **Глобальные тач-мелочи** (`mobile.css`): `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation` у кнопок (убирает задержку и двойной тап), `overscroll-behavior: contain` у лент и drawer.
8. **Страницы Login/Register/VerifyEmail** (`index.css`): фиксированные `width: 580px` / `460px` → `width: min(580px, 100% - 32px)`, отступы 16 px, учёт safe-area.
9. **Dev-оверлей `components/dev/LayoutDebugOverlay.tsx`.** Монтируется только при `import.meta.env.DEV`, включается через `?debugLayout=1` или `localStorage.debugLayout = "1"`. По `requestAnimationFrame` / `ResizeObserver` и кнопке «Scan»:
   - находит элементы с `getBoundingClientRect().right > innerWidth + 1` или `left < -1` (кроме тех, что внутри `overflow: hidden/auto`-предка, обрезающего их) → красная обводка + `console.warn` с селектором;
   - находит видимые `button`, `a`, `[role=button]`, `input` с размером меньше 44×44 → оранжевая обводка;
   - находит перекрытые кнопки: `document.elementFromPoint(центр)` не совпадает с самой кнопкой и не лежит внутри неё → фиолетовая обводка;
   - в углу показывает счётчик `overflow: N · small: N · covered: N`.

### Этап 2. Layout: drawer, шапка, клавиатура, композер

1. **Сетка на мобильном** (`mobile.css`): `.chat-layout { grid-template-columns: minmax(0, 1fr); height: var(--app-height); }`. `.servers-sidebar` и `.channels-sidebar` выводятся из сетки и вместе становятся содержимым drawer.
2. **Drawer «серверы + каналы»:**
   - Разметка: rail серверов (`.servers-sidebar`, ширина ~64 px) слева и список каналов справа — в одном контейнере `.mobile-drawer` с шириной `min(88vw, 360px)`, `position: fixed; inset: 0 auto 0 0; z-index: var(--z-drawer)`. Можно либо обернуть существующие `<aside>` в `ChatPage.tsx` в общий контейнер, либо вынести в `MobileDrawer.tsx`. Десктопную разметку не ломать: на десктопе контейнер `display: contents`.
   - Анимация только через `transform: translateX(-100%) → 0` и `opacity` у оверлея (`--z-drawer-overlay`). У закрытого drawer `visibility: hidden` после анимации (через `transitionend` или `transition: visibility 0s .26s`) — чтобы скрытые элементы не перехватывали тапы и фокус. Убрать нынешние трюки с `translateX(calc(-100% - 60px))` и `pointer-events`.
   - Drawer закрывается после выбора канала или DM, тапом по оверлею, кнопкой «назад» (этап 3) и свайпом (этап 5).
   - **Внизу drawer — блок пользователя** (аватар, имя, кнопка ⚙): открывает профиль (замена кнопки профиля из шапки).
   - Состояние: использовать существующий `isChannelsDrawerOpen`. Существующий флаг скрытия сайдбара (`channels-sidebar-hidden`) на мобильном игнорировать.
   - Пока drawer закрыт, а сервер или канал не выбраны (первый вход) — открыть drawer автоматически.
3. **Однострочная шапка** (`.chat-header-block`):
   - Высота `var(--header-h)` + `padding-top: var(--safe-top)`, боковые отступы с учётом `--safe-left/right`.
   - Слева ☰ (`channels-hamburger-btn`). По центру — двухуровневый текст в одну «строку» шапки: `# канал` (жирный, ellipsis) и мелкая подпись `сервер` или `Личные сообщения` (ellipsis). Справа 🔍 и ⋮.
   - На мобильном скрыть `.chat-subheader` и `profile-open-btn` (они переезжают в шапку и в drawer).
   - **Меню ⋮** открывает `<Sheet>` (этап 3) с пунктами: «Участники онлайн» (содержимое нынешней `.online-users-panel` из `MessageInput.tsx`), «Уведомления канала» (то, что сейчас даёт `notificationMenu.openChannelMenu`), «Настройки голоса» (`VoiceSettingsModal`), «Профиль». До этапа 3 — временно как обычный `ContextMenu`.
   - На мобильном скрыть кнопку `.message-online-toggle-btn` и `.message-actions-wrap` в композере (переехали в ⋮).
4. **`useVisualViewport.ts`** (вызывается один раз в `ChatPage`, только на мобильном):
   - Подписаться на `visualViewport.resize` и `scroll` (fallback — `window.resize`). В `rAF` писать на `document.documentElement` `--app-height = vv.height px` и `--keyboard-inset = max(0, innerHeight - vv.height - vv.offsetTop) px`.
   - На мобильном: `html, body { position: fixed; inset: 0; overflow: hidden; height: var(--app-height); }`, при этом лента сообщений — единственный скролл-контейнер (`overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch`).
   - В iOS при фокусе на input браузер скроллит окно. После `focus` сделать `window.scrollTo(0, 0)` в `rAF`.
   - Когда клавиатура открывается и пользователь был внизу ленты (использовать логику из `useJumpToLatest`), прокрутить ленту к низу.
   - В `index.html` в meta viewport добавить `interactive-widget=resizes-content` (Android Chrome будет корректно ресайзить layout, на iOS хук справится сам).
5. **Однострочный композер** (`MessageInput.tsx` + `mobile.css`):
   - Ряд: `📎 (attach) · поле · 🎤 (voice) | ➤ (send)`. Кнопка отправки показывается вместо микрофона, когда в поле есть текст или вложения. Все кнопки по 44 px.
   - Поле растёт до 5 строк. Сейчас это `<input>`, поэтому заменить на `<textarea rows=1>` с авто-ресайзом (`scrollHeight`, cap 5 строк). Сохранить текущее поведение: Enter отправляет на десктопе. **На тач-устройствах Enter вставляет перенос строки, а отправка — только кнопкой ➤.** Проверить совместимость с `MentionAutocomplete` (позиция и навигация стрелками), с typing emitter, с лимитом длины (`messageLimits.ts`) и с режимом ответа (reply preview над полем).
   - `padding-bottom: max(8px, var(--safe-bottom))`, но когда клавиатура открыта (`--keyboard-inset > 0`), safe-area не добавлять (класс `keyboard-open` на `html`, ставится в `useVisualViewport`).
   - Если правка `MessageInput` под textarea окажется слишком рискованной, допустимый fallback — оставить `<input>`, но в один ряд. Зафиксировать это в описании PR.
6. **`JumpToLatestButton`, `TypingIndicator`** — пересчитать позиции относительно нового композера, `z-index: var(--z-sticky)`.

### Этап 3. `<Sheet>`, долгое нажатие, модалки, «назад»

1. **`components/Sheet.tsx` + `styles/sheet.css`.**
   ```ts
   type SheetProps = {
     open: boolean;
     onClose: () => void;
     title?: string;
     variant?: "modal" | "popover" | "menu";  // поведение на десктопе
     anchor?: { x: number; y: number } | DOMRect; // для popover/menu на десктопе
     children: React.ReactNode;
     className?: string;
   };
   ```
   - Рендер через `createPortal(…, document.body)`.
   - **Мобильный режим (`useIsMobile`):** оверлей `--z-sheet-overlay` с `backdrop-filter: blur(6px)` и тёмным фоном. Панель прижата к низу, `max-height: 90dvh`, скругление сверху, грабер, `padding-bottom: var(--safe-bottom)`, внутренний скролл. Анимация `translateY(100%) → 0`. Закрытие тапом по фону, свайпом вниз по граберу или заголовку (порог 80 px или скорость > 0.5 px/ms) и через «назад».
   - **Десктоп:** `variant="modal"` — по центру, как нынешние `.modal-card`. `"popover"`/`"menu"` — по `anchor` с clamp в viewport (логику clamp перенести из `ContextMenu.tsx`).
   - Общее: `Esc` закрывает, фокус переходит внутрь при открытии и возвращается при закрытии, `role="dialog"`, `aria-modal`, блокировка скролла body (`useBodyScrollLock`), поддержка закрывающей анимации (замена нынешнего `closingModal` / `closeModalWithAnim` в `ChatPage`).
2. **Перевести на `<Sheet>`:**
   - модалки в `ChatPage.tsx`: профиль (~стр. 1151), создание сервера (~1397), присоединение к серверу (~1432);
   - `VoiceSettingsModal.tsx`, `NotificationSettingsModal.tsx`, `UserSearchModal.tsx`;
   - `ContextMenu.tsx` — превратить во «внутренности» `<Sheet variant="menu">`: тот же API `items`, на мобильном рендерится крупными пунктами (высота 48 px, иконка + текст, danger красным);
   - `.voice-volume-popover` (громкость участника, `ChatPage` ~стр. 858) → `<Sheet variant="popover">`;
   - `.online-users-panel` → контент пункта «Участники онлайн» из меню ⋮;
   - `ImageViewerModal` — оставить полноэкранным (не bottom sheet), но перевести на `--z-screen`, добавить закрытие через «назад» и pinch-zoom (`touch-action: pinch-zoom` на изображении, без самописного зума).
3. **`hooks/useLongPress.ts`:**
   - pointer events (`pointerdown/move/up/cancel`). Таймер 450 мс. Отмена, если сдвиг больше 10 px (скролл) или при `pointerup` раньше времени. Игнорировать `pointerType === "mouse"`.
   - По срабатыванию: `navigator.vibrate?.(10)` и `onLongPress(event, rect)`.
   - Подавить системные эффекты на элементах с long-press: `-webkit-touch-callout: none; user-select: none` (только на тач-экране, `@media (hover: none)`). Чтобы клик не срабатывал после long-press, флагом гасить следующий `click`.
4. **Действия над сообщением (`MessageList.tsx`):**
   - На тач-экране (`useIsTouch`): `useLongPress` на `.message-item` открывает `<Sheet variant="menu">` с пунктами из существующего `buildMenuItems(msg)`. Если в `buildMenuItems` нет «Копировать текст», добавить пункт (`navigator.clipboard.writeText`, toast «Скопировано»).
   - На тач-экране скрыть inline-кнопки `.message-reply-btn`, `.message-delete-btn`: удалить правило `@media (hover: none) { opacity: 1 }` из `chat.css`, в `mobile.css` задать `display: none` при `(hover: none)`. Подтверждение удаления делать внутри Sheet («Удалить сообщение?» → «Удалить» / «Отмена»), а не inline.
   - Inline-редактирование (`.message-edit`): кнопки «Сохранить/Отмена» по 44 px, подсказку про Enter/Esc уже скрывает CSS.
   - Десктоп: hover-кнопки и `onContextMenu` работают как раньше.
5. **Long-press для серверов, каналов и DM:** в `ChatPage.tsx` (`notificationMenu.openServerMenu` ~стр. 654, `openChannelMenu` ~772, `openDMContextMenu` ~753; `DMList.tsx`) на тач-экране добавить `useLongPress`, который вызывает те же обработчики. Хуку `useNotificationContextMenu` нужно принимать позицию не только из `MouseEvent` (передать `{x, y}` или rect). Меню открывается в `<Sheet variant="menu">`.
6. **`hooks/useBackDismiss.ts`:**
   ```ts
   useBackDismiss(isOpen: boolean, onClose: () => void, key: string)
   ```
   - При `isOpen` false→true: `history.pushState({ overlay: key }, "")` и регистрация в модульном стеке.
   - Глобальный (один) слушатель `popstate` закрывает **верхний** оверлей стека.
   - Если оверлей закрыт не через «назад» (тап, Esc): снять из стека и вызвать `history.back()` с флагом `ignoreNextPop`, чтобы слушатель не закрыл следующий.
   - Применить к: drawer, всем `<Sheet>` (внутри компонента), полноэкранному поиску, `ImageViewerModal`, полноэкранному звонку.
   - Работает только на мобильном. На десктопе — no-op, чтобы не засорять историю.

### Этап 4. Звонок: мини-бар и полноэкранный режим

Логика остаётся в `useVoice`, меняется только компоновка. На десктопе `.voice-panel` остаётся как есть.

1. **`VoiceMiniBar.tsx`** (мобильный, когда `isInVoiceCall` и экран звонка свёрнут):
   - Тонкая полоса ~48 px над композером (`z-index: var(--z-callbar)`): индикатор качества (`ConnectionQualityIcon`), название голосового канала (ellipsis) и время в звонке, кнопки 🎤 (toggle mic) и ⏏/✕ (Leave), всё по 44 px.
   - Тап по свободной зоне разворачивает `CallScreen`.
   - Видна на любом экране чата (в том числе в другом канале или DM). Пока открыта клавиатура (`html.keyboard-open`), прячется.
   - Если пользователь открыл голосовой канал, но не подключён (`isVoiceChannel && !isInVoiceCall`), в ленте вместо панели показываем карточку «Подключиться» с одной крупной кнопкой.
2. **`CallScreen.tsx`** (`position: fixed; inset: 0; z-index: var(--z-screen)`):
   - Шапка: «⌄ свернуть» (с `useBackDismiss`), название канала, `voice-quality-badge`.
   - Центр: сетка `VideoTile` (все участники). Portrait: 1 участник — на весь экран, 2 — столбиком, 3–4 — 2×2, больше — 2 колонки со скроллом. Landscape: горизонтальная лента с `scroll-snap` (перенести правило из старого landscape-блока). Участники без видео — аватар-плитки с индикатором голоса (как в `.voice-members-list`). Тап по плитке пользователя открывает `<Sheet>` громкости (бывший `.voice-volume-popover`).
   - Нижний ряд крупных кнопок (56 px, подписи под иконками): Mic, Camera, Switch camera (на тач-экране) или Screen share (на десктопе), Настройки голоса, Leave (красная). `padding-bottom: var(--safe-bottom)`.
   - Удерживать экран включённым во время звонка (`navigator.wakeLock?.request("screen")` при открытом `CallScreen`, освобождать при сворачивании или уходе, ошибки игнорировать).
   - Кнопка полноэкранного видео (`.video-fullscreen-btn`) остаётся на плитках.
   - При входе в звонок на мобильном `CallScreen` открывается автоматически, если у кого-то включено видео, иначе показываем только мини-бар.
3. Список участников голосового канала в drawer (`.voice-members-list`) остаётся. Popover громкости там тоже переводится на `<Sheet>`.

### Этап 5. Свайпы, поиск, производительность, полировка

1. **`hooks/useSwipe.ts`:**
   - Pointer/touch events на контейнере. Жест распознаётся, если |dx| > 60 px и |dx| > 2·|dy|. Направление фиксируется после первых 10 px движения: если доминирует вертикаль, жест отменяется до конца касания.
   - Стартовая точка дальше 20 px от левого края экрана (не конфликтуем с системным «назад» iOS и Android).
   - Не реагировать, если касание началось внутри `pre`, `code`, `input`, `textarea`, `[contenteditable]`, `.video-grid`, `.media-player`, `.video-player`, `[data-no-swipe]` или любого элемента с горизонтальным скроллом (`scrollWidth > clientWidth` по пути к корню).
   - Применение: на области чата свайп вправо открывает drawer, на drawer или оверлее свайп влево закрывает.
2. **Поиск (`SearchPanel.tsx`):** на мобильном это полноэкранный экран `--z-screen` (уже частично так). В шапке ← (закрыть, `useBackDismiss`) и поле поиска с автофокусом. Тап по результату закрывает поиск и переходит к сообщению (существующая логика `get_messages_around`). Проверить, что клавиатура не перекрывает результаты (`--app-height`).
3. **Производительность** (`mobile.css`):
   - Отключить `backdrop-filter` у `.servers-sidebar`, `.channels-sidebar`, drawer, шапки, композера и мини-бара: непрозрачный фон того же оттенка (`rgba(7,8,10,.96)` в тёмной теме, соответствующий светлый — проверить `[data-theme="light"]`).
   - Blur оставить только у оверлеев Sheet и drawer (короткоживущие).
   - `body { background-attachment: scroll; }` (уже есть), фоновые blob-анимации отключить (`animation: none`).
   - У анимируемых drawer и Sheet — `will-change: transform` только на время анимации. Анимации только через `transform`/`opacity`.
   - Убрать глобальное `button:active { transform: scale(0.97) }` для элементов внутри скролл-лент (оно мешает при скролле пальцем). Вместо этого `:active` меняет фон.
4. **Полировка:**
   - `Toast` — `z-index: var(--z-toast)`, позиция сверху с `--safe-top` (не перекрывать композер).
   - `NotificationPermissionBanner` — компактный, не толкает layout горизонтально.
   - `MediaPlayer`/`VideoPlayer` в сообщениях: `max-width: 100%`, контролы ≥ 44 px, в `mediaPlayer.css`/`videoPlayer.css` перенести 480-правила в `mobile.css`.
   - Светлая тема: проверить все новые компоненты в `[data-theme="light"]`.
   - `prefers-reduced-motion`: drawer, Sheet и CallScreen без анимации.

---

## 5. Критерии приёмки

На ширинах 360, 375, 390, 412 и 430 px (portrait), а также на 844×390 и 915×412 (landscape):

1. Нет горизонтального скролла: `document.documentElement.scrollWidth <= innerWidth` в любом состоянии (длинная ссылка без пробелов, блок кода, превью ссылки, видео, аудиоплеер). Dev-оверлей показывает `overflow: 0`.
2. Правый край контента не обрезается и не сужается; отступы симметричны, с учётом safe-area.
3. Все интерактивные элементы ≥ 44×44 по хит-зоне, ни один не перекрыт другим слоем. Dev-оверлей: `small: 0`, `covered: 0` (допустимые исключения перечислить в описании PR).
4. Открытие клавиатуры не сдвигает шапку за экран, композер остаётся прямо над клавиатурой, лента не прыгает. На iOS нет авто-зума при фокусе.
5. «Назад» в браузере закрывает верхний оверлей (sheet → drawer → поиск → звонок) и не уводит со страницы, пока что-то открыто.
6. Долгое нажатие на сообщение, сервер, канал и DM открывает меню, в том числе в iOS Safari. Нет системного callout и выделения текста.
7. Свайп вправо по чату открывает drawer, влево — закрывает. Вертикальный скролл ленты, горизонтальный скролл кода и видео-ленты, системный «назад» от края — не ломаются.
8. Звонок: мини-бар виден во всех каналах, разворачивается в полноэкранный режим, все кнопки работают. В landscape видео — горизонтальная лента.
9. Десктоп (≥ 1025 px) и планшет (769–1024 px) выглядят и работают как до изменений, за исключением исправленного overflow.
10. `npm run lint` и `npm run build` проходят без ошибок.

---

## 6. Чек-лист ручной проверки

**Инструменты.** `cd frontend && npm run dev -- --host`, открыть `http://<LAN-IP>:5173/?debugLayout=1` на телефоне. Для WebSocket и API проверить `.env.development` — `VITE_API_URL` должен указывать на адрес, доступный с телефона, а не на `localhost`. Chrome DevTools → Device Mode: iPhone SE, iPhone 14 Pro, Pixel 7, Galaxy S20 Ultra, а также landscape.

**Обязательно на реальных устройствах:** iPhone (Safari, а также «На экран Домой» — standalone PWA с `black-translucent` статус-баром) и Android (Chrome).

Сценарии:

- [ ] Логин и регистрация: форма помещается, нет зума, клавиатура не перекрывает кнопку.
- [ ] Первый вход без выбранного канала: drawer открыт.
- [ ] Выбор сервера → канала: drawer закрывается, шапка показывает канал и сервер.
- [ ] DM: переход, шапка показывает собеседника, поиск пользователей (`UserSearchModal`) в Sheet.
- [ ] Отправка текста, длинной ссылки, кода, эмодзи; многострочного текста (Enter = перенос строки на тач-экране).
- [ ] Вложение файла и изображения; просмотр изображения, pinch-zoom, «назад» закрывает.
- [ ] Голосовое сообщение (кнопка микрофона в композере).
- [ ] Упоминание через `@` — автокомплит виден над клавиатурой и кликабелен.
- [ ] Long-press на сообщении → ответить, редактировать, копировать, удалить (с подтверждением).
- [ ] Long-press на сервере, канале и DM → меню уведомлений.
- [ ] Меню ⋮: онлайн-участники, уведомления канала, настройки голоса, профиль.
- [ ] Профиль из нижней части drawer: смена аватара и ника.
- [ ] Поиск: открыть, ввести запрос, перейти к результату, «назад».
- [ ] Звонок: войти → мини-бар → развернуть → mic, камера, смена камеры, громкость участника → свернуть → перейти в другой канал (мини-бар остаётся) → выйти.
- [ ] Поворот экрана во время звонка и в чате.
- [ ] Кнопка «назад» на каждом оверлее; при отсутствии оверлеев — обычное поведение.
- [ ] Свайпы drawer; свайп по блоку кода и видео-ленте не открывает drawer.
- [ ] Светлая и тёмная тема.
- [ ] Плавность скролла длинной ленты на среднем Android.
- [ ] Регресс на десктопе: hover-кнопки, правый клик, модалки по центру, поиск в 4-й колонке, `voice-panel`.

---

## 7. Риски и как с ними обращаться

| Риск | Митигация |
|---|---|
| Замена `<input>` на `<textarea>` в `MessageInput` ломает автокомплит, typing или отправку | Сделать отдельным коммитом, тщательно прогнать сценарии композера. При проблемах использовать fallback из этапа 2.5. |
| `useBackDismiss` даёт двойной «назад» или «вылет» | Один глобальный слушатель, модульный стек, флаг `ignoreNextPop`. Проверить последовательности «открыть 2 оверлея → закрыть тапом → назад». |
| `position: fixed` на body ломает что-то на десктопе | Применять только внутри мобильного медиа-запроса. |
| Перенос CSS в `mobile.css` меняет каскад | `mobile.css` импортируется последним. Переносить блоками, сравнивая визуально до и после на 375/768/1024/1440. |
| Long-press конфликтует с выделением текста для копирования | Для копирования есть отдельный пункт «Копировать текст» в меню. |
| Разные z-index в старом коде | Все литералы заменяются на токены из 3.2, `grep "z-index"` после этапа 1 должен показывать только `var(--z-*)` (и локальные 0–3 внутри компонентов). |

---

## 8. Описание PR (шаблон)

```
feat(frontend): mobile web UI overhaul

- Single mobile breakpoint (useIsMobile / mobile.css), z-index & tap-size tokens
- Fix horizontal overflow (minmax(0,1fr), min-width:0, wrapping)
- Discord-style drawer (servers + channels), one-line header with ⋮ menu
- visualViewport-based keyboard handling, one-line auto-growing composer
- <Sheet> component: bottom sheets on mobile, modals/popovers on desktop
- Long-press actions for messages/servers/channels/DMs (works on iOS)
- Back button closes overlays (useBackDismiss)
- Voice: mini call bar + fullscreen call screen
- Swipe to open/close drawer, perf: no persistent blur on mobile
- Dev-only layout debug overlay (?debugLayout=1)

Tested on: <устройства / браузеры>
Known exceptions: <если есть>
```
