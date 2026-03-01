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

