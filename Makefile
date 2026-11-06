# Everyday commands. Run `make` to list them.
#
# Migration commands run inside a one-off backend container with ./backend mounted,
# so new revision files land in the repo and nothing needs installing locally.

COMPOSE := docker compose
DEV     := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml
# One-off backend container: source mounted, talks to the compose db service.
ALEMBIC := $(COMPOSE) run --rm -v $(CURDIR)/backend:/app backend alembic

.DEFAULT_GOAL := help
.PHONY: help up down build logs ps restart db-up db-shell db-reset \
        migrate downgrade revision history current check sql seed

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ---------- stack ----------

up: ## Build and start everything (http://localhost:8080)
	$(COMPOSE) up -d --build

down: ## Stop everything (data is kept)
	$(COMPOSE) down

build: ## Rebuild images
	$(COMPOSE) build

logs: ## Follow backend logs
	$(COMPOSE) logs -f backend

ps: ## Show service status
	$(COMPOSE) ps

restart: ## Restart the backend (runs migrations again on start)
	$(COMPOSE) restart backend

# ---------- database ----------

db-up: ## Start only Postgres, exposed on localhost:55432 for local dev
	$(DEV) up -d db

db-shell: ## Open psql
	$(COMPOSE) exec db psql -U wharfline -d wharfline

db-reset: ## Delete all data and start fresh with sample data
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build

seed: ## Load sample data into an empty database
	$(COMPOSE) exec backend python -m app.prestart

# ---------- migrations ----------

migrate: ## Apply all pending migrations
	$(ALEMBIC) upgrade head

downgrade: ## Roll back one migration
	$(ALEMBIC) downgrade -1

revision: ## Create a migration from model changes: make revision m="add column x"
	@test -n "$(m)" || (echo 'usage: make revision m="describe the change"' && exit 1)
	$(ALEMBIC) revision --autogenerate -m "$(m)"
	@echo "Review the new file in backend/migrations/versions before committing."

history: ## List migrations
	$(ALEMBIC) history --verbose

current: ## Show the revision the database is on
	$(ALEMBIC) current

check: ## Fail if models and migrations are out of sync
	$(ALEMBIC) check

sql: ## Print the SQL for all migrations without running it
	$(ALEMBIC) upgrade head --sql
