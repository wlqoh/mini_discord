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

## Voice/Video channels (WebRTC)

- Calls use the same websocket endpoint: `/api/v1/server/ws`.
- Channel types:
  - `text` for chat
  - `voice` for voice/video rooms
- Signaling actions over websocket:
  - `join_voice_channel`
  - `leave_voice_channel`
  - `rtc_signal` (`offer`, `answer`, `candidate`)

### Frontend env for WebRTC

```bash
VITE_API_URL=/api/v1
VITE_WEBRTC_STUN_URLS=stun:stun.l.google.com:19302
VITE_WEBRTC_TURN_URLS=turn:turn.your-domain.com:3478?transport=udp,turns:turn.your-domain.com:5349?transport=tcp
VITE_WEBRTC_TURN_USERNAME=mini_discord
VITE_WEBRTC_TURN_CREDENTIAL=change-me
# optional debug switch (forces TURN relay only)
VITE_WEBRTC_FORCE_RELAY=false
```

For docker-compose production build, export the same `VITE_*` variables in shell (or `.env`) before running:

```bash
docker compose up -d --build
```

Example file: `frontend/.env.production.example`.

### Required TURN setup for stable production calls

Without TURN, calls can work inconsistently across different ISPs/NATs (exactly the case when VPN helps some users).

1. Set TURN variables in your deployment `.env`:

```bash
TURN_REALM=your-domain.com
TURN_PUBLIC_IP=YOUR_SERVER_PUBLIC_IP
TURN_USERNAME=mini_discord
TURN_PASSWORD=strong-turn-password

VITE_WEBRTC_TURN_URLS=turn:your-domain.com:3478?transport=udp,turn:your-domain.com:3478?transport=tcp
VITE_WEBRTC_TURN_USERNAME=mini_discord
VITE_WEBRTC_TURN_CREDENTIAL=strong-turn-password
VITE_WEBRTC_FORCE_RELAY=false
```

2. Open firewall ports on the host:

- `3478/tcp`
- `3478/udp`
- `49160-49200/udp`

3. Rebuild and restart:

```bash
docker compose down
docker compose up -d --build
```

Optional websocket override:

```bash
VITE_WS_URL=wss://your-domain.com/api/v1/server/ws
```

### Origin allow-lists

Configure allowed browser origins in backend config:

- `http_server.cors_allowed_origins`
- `http_server.ws_allowed_origins`

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

## Окружения

Приложение поддерживает три режима работы через параметр `env` в конфигурации:

| Окружение | Уровень логов |
|-----------|---------------|
| `local`   | Debug (JSON)  |
| `dev`     | Debug (JSON)  |
| `prod`    | Info (JSON)   |

## Лицензия

MIT

