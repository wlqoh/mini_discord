-include local.env
export

MIGRATIONS=./sql/schema

# DEPLOY_TARGET / DEPLOY_PATH / DEPLOY_KEY are set in local.env (gitignored),
# not here, so the server address/user isn't checked into git.
DEPLOY_KEY ?= ~/.ssh/mini_discord_deploy

build:
	@go build -o bin/discord_go.exe cmd/discord_go/main.go

.PHONY: up down genvapid deploy doc-check docs-check install-hooks

doc-check:
	@go run scripts/doccheck.go -max 0 .

docs-check:
	@go run scripts/docscheck.go .

# Points git at .githooks so pre-commit runs doc-check/docs-check on
# relevant staged changes. The same two checks also run in CI (job
# "backend"), so this hook is fast local feedback, not the only place
# they run — bypassing it with `git commit --no-verify` just defers the
# check to the PR instead of skipping it. Run once per clone.
install-hooks:
	git config core.hooksPath .githooks
	@echo "pre-commit hook installed (runs doc-check/docs-check on staged Go/doc changes)"

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
