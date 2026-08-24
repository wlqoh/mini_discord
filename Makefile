include local.env
export

MIGRATIONS=./sql/schema

# DEPLOY_TARGET / DEPLOY_PATH / DEPLOY_KEY are set in local.env (gitignored),
# not here, so the server address/user isn't checked into git.
DEPLOY_KEY ?= ~/.ssh/mini_discord_deploy

build:
	@go build -o bin/discord_go.exe cmd/discord_go/main.go

.PHONY: up down genvapid deploy doc-check

doc-check:
	@go run scripts/doccheck.go -max 0 .

up:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" up

down:
	goose -dir $(MIGRATIONS) postgres "$(DB_URL)" down

run: build
	@./bin/discord_go.exe

genvapid:
	@go run ./cmd/genvapid

deploy:
	@scripts/deploy.sh --target $(DEPLOY_TARGET) --path $(DEPLOY_PATH) --identity $(DEPLOY_KEY) $(ARGS)
