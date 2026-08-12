include local.env
export

MIGRATIONS=./sql/schema

build:
	@go build -o bin/discord_go.exe cmd/discord_go/main.go

.PHONY: up down genvapid

up:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" up

down:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" down

run: build
	@./bin/discord_go.exe

genvapid:
	@go run ./cmd/genvapid
