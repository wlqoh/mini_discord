include local.env
export

MIGRATIONS=./sql/schema

build:
	@go build -o bin/discord_go cmd/discord_go/main.go

.PHONY: up down

up:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" up

down:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" down

run: build
	@./bin/discord_go
